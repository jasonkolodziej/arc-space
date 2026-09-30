import * as vscode from 'vscode';
import * as path from 'path';
import {
  cfg, rr, runRemote, q, errMsg, utsaId, holdName, nodeHost, arcTerminal, arcUri, onArc, windowHost, sleep,
} from './transport';
import { getPartitions, getJobs, gpuGres, Partition, Job, submitHolder, scontrolField } from './slurm';
import { ensureSignedIn, workspacePath } from './setup';

export type Report = (line: string) => void;
let refreshHook: () => void = () => undefined;
export const setRefreshHook = (f: () => void) => { refreshHook = f; };
export const refreshAll = () => refreshHook();

async function guard(): Promise<boolean> {
  if (!utsaId()) {
    const a = await vscode.window.showWarningMessage('Arc is not set up yet.', 'Run setup');
    if (a) await vscode.commands.executeCommand('arc.setup.all');
    return false;
  }
  return ensureSignedIn();
}

async function showText(title: string, body: string) {
  const doc = await vscode.workspace.openTextDocument({ content: `${title}\n${'─'.repeat(Math.min(title.length, 80))}\n\n${body}` });
  await vscode.window.showTextDocument(doc, { preview: true });
}

// ─────────────── partition / walltime pickers ───────────────

export async function choosePartition(preset?: string): Promise<Partition | undefined> {
  const parts = (await getPartitions()).filter(p => p.avail === 'up');
  if (preset) return parts.find(p => p.name === preset) ?? Promise.reject(new Error(`Unknown or unavailable partition "${preset}"`));
  const pick = await vscode.window.showQuickPick(parts.map(p => {
    const idle = p.states.get('idle') ?? 0;
    const gpu = gpuGres(p.gres);
    return { label: `${idle > 0 ? '$(pass-filled)' : '$(watch)'} ${p.name}`, description: `${idle}/${p.total} idle`,
      detail: `${p.cpus} cores · ~${p.memGB} GB · ${gpu ?? 'no GPU'} · max ${p.timeLimit}`, p };
  }).sort((a, b) => (b.p.states.get('idle') ?? 0) - (a.p.states.get('idle') ?? 0)),
  { placeHolder: 'Partition (sorted by idle nodes — nodes are exclusive per user, so only idle ones are allocatable)', matchOnDetail: true });
  return pick?.p;
}

const WALL = /^(\d+-)?\d{1,3}:\d{2}:\d{2}$/;
export async function chooseWalltime(p: Partition, preset?: string): Promise<string | undefined> {
  if (preset) { if (!WALL.test(preset)) throw new Error(`Bad walltime "${preset}"`); return preset; }
  return vscode.window.showInputBox({
    prompt: `Walltime for ${p.name} (max ${p.timeLimit})`, value: cfg().get<string>('defaultWalltime', '04:00:00'),
    validateInput: v => WALL.test(v) ? undefined : 'Use HH:MM:SS or D-HH:MM:SS',
  });
}

export async function gpuGuard(p: Partition, interactive: boolean): Promise<boolean> {
  if (!gpuGres(p.gres)) return true;
  const msg = `${p.name} is a GPU partition. Arc terminates jobs whose GPUs are idle for more than 1 hour — ` +
    `holding a GPU node just to edit code will get the job killed.`;
  if (!interactive) { vscode.window.showWarningMessage(msg); return true; }
  return (await vscode.window.showWarningMessage(msg, { modal: true }, 'Allocate anyway')) === 'Allocate anyway';
}

// ─────────────── allocation ───────────────

export async function allocate(o: { partition?: string; walltime?: string; report?: Report; token?: vscode.CancellationToken } = {}) {
  if (!(await guard())) return;
  const report = o.report ?? (() => undefined);
  const hold = holdName();
  const existing = (await getJobs()).find(j => j.name === hold);
  if (existing) {
    const a = await vscode.window.showWarningMessage(
      `A '${hold}' job already exists (${existing.id}, ${existing.state}).`, 'Open on node', 'Replace it', 'Cancel');
    if (a === 'Open on node') return connectNode();
    if (a !== 'Replace it') return;
    await rr('scancel', [existing.id]);
    report(`cancelled previous holder ${existing.id}`);
  }
  const p = await choosePartition(o.partition);
  if (!p) return;
  const time = await chooseWalltime(p, o.walltime);
  if (!time || !(await gpuGuard(p, !o.partition))) return;
  const gpu = cfg().get<boolean>('requestGpuGres', true) ? gpuGres(p.gres) : undefined;

  const id = await submitHolder({ name: hold, p, time, gpu });
  report(`submitted holder job ${id}: ${p.name}, ${time}, ${p.cpus} cores${gpu ? ', ' + gpu : ''}`);
  refreshAll();

  const node = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, cancellable: true, title: `Arc: waiting for a ${p.name} node (job ${id})`,
  }, async (progress, token) => {
    let last = '';
    for (let i = 0; i < 240; i++) {
      if (token.isCancellationRequested || o.token?.isCancellationRequested) return undefined;
      const [state, nodeName, reason] = (await rr('squeue', ['-h', '-j', id, '-o', '%T|%N|%R']).catch(() => '')).trim().split('|');
      if (state === 'RUNNING') return nodeName;
      if (!state) throw new Error(`job ${id} left the queue — see ~/.arc/logs on Arc`);
      const line = `${state.toLowerCase()} (${reason})`;
      if (line !== last) { report(line); last = line; }
      progress.report({ message: line });
      await sleep(5000);
    }
    return undefined;
  });
  refreshAll();
  if (!node) { report(`job ${id} is still queued; the status bar updates when it starts`); return; }
  report(`READY: ${node}`);

  const canSsh = cfg().get<boolean | null>('nodeSshAvailable', null) !== false;
  const a = await vscode.window.showInformationMessage(`Node ${node} is ready (job ${id}, ${time}).`,
    ...(canSsh ? ['Open VS Code on node'] : []), 'Attach shell');
  if (a === 'Open VS Code on node') await connectNode();
  if (a === 'Attach shell') attachShell(id);
}

export async function connectNode() {
  if (!(await guard())) return;
  if (cfg().get<boolean | null>('nodeSshAvailable', null) === false) {
    const a = await vscode.window.showWarningMessage(
      'Verification found that SSH to compute nodes is not available, so VS Code cannot open on the node. ' +
      'Use "Attach Shell to Job" instead.', 'Re-run verification');
    if (a) await vscode.commands.executeCommand('arc.setup.verify');
    return;
  }
  const holder = (await getJobs()).find(j => j.name === holdName() && j.state === 'RUNNING');
  if (!holder) { const a = await vscode.window.showWarningMessage('No running holder job.', 'Allocate'); if (a) await allocate(); return; }
  const wf = vscode.workspace.workspaceFile;
  const target = onArc() && wf && wf.scheme === 'vscode-remote' ? wf.path
    : onArc() && vscode.workspace.workspaceFolders?.[0] ? vscode.workspace.workspaceFolders[0].uri.path
    : workspacePath();
  await vscode.commands.executeCommand('vscode.openFolder',
    vscode.Uri.parse(`vscode-remote://ssh-remote+${nodeHost()}${target}`), { forceNewWindow: true });
}

export async function releaseNode() {
  if (!(await guard())) return;
  const hold = holdName();
  const ok = await vscode.window.showWarningMessage(
    `Cancel your '${hold}' job? Any VS Code window on that node will disconnect.`, { modal: true }, 'Release');
  if (ok) { await rr('scancel', ['-u', utsaId(), `--name=${hold}`]); refreshAll(); }
}

export async function releaseNodeQuiet(): Promise<string> {
  await rr('scancel', ['-u', utsaId(), `--name=${holdName()}`]);
  refreshAll();
  return `released '${holdName()}' job(s)`;
}

export function attachShell(jobId: string) {
  const overlap = cfg().get<boolean>('srunOverlap', true) ? ' --overlap' : '';
  arcTerminal(`job ${jobId}`, `srun --jobid=${jobId}${overlap} --pty bash -l`);
}

export function interactiveScript(p: Partition, time: string): string {
  const gpu = cfg().get<boolean>('requestGpuGres', true) ? gpuGres(p.gres) : undefined;
  return `srun -p ${p.name} -n 1 -t ${time} -c ${p.cpus || 1}${gpu ? ` --gres=${gpu}` : ''} --pty bash -l`;
}
export async function interactiveShell() {
  if (!(await guard())) return;
  const p = await choosePartition();
  if (!p) return;
  const time = await chooseWalltime(p);
  if (!time || !(await gpuGuard(p, true))) return;
  arcTerminal(`srun ${p.name}`, interactiveScript(p, time));
}

// ─────────────── batch + job control ───────────────

function arcPathOf(uri?: vscode.Uri): string | undefined {
  if (!uri || uri.scheme !== 'vscode-remote' || !onArc()) return undefined;
  return uri.path;
}

export async function submitBatch(uri?: vscode.Uri) {
  if (!(await guard())) return;
  const u = uri ?? vscode.window.activeTextEditor?.document.uri;
  const p = arcPathOf(u);
  if (!p || !u) { vscode.window.showWarningMessage('Open the batch script from an Arc window (it must live on Arc).'); return; }
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === u.toString());
  if (doc?.isDirty) await doc.save();
  try {
    const id = (await runRemote(`cd ${q(path.posix.dirname(p))} && sbatch --parsable ${q(p)}`)).trim().split(';')[0];
    const a = await vscode.window.showInformationMessage(`Submitted ${path.posix.basename(p)} → job ${id}`, 'Follow log');
    refreshAll();
    if (a) followLog(id);
  } catch (e) { vscode.window.showErrorMessage(`sbatch: ${errMsg(e)}`); }
}

export function jobFromArg(arg: unknown): Job | undefined {
  const d = (arg as { data?: unknown })?.data;
  return d && typeof d === 'object' && 'id' in d ? (d as Job) : undefined;
}
export async function pickJob(arg: unknown, filter: (j: Job) => boolean = () => true): Promise<Job | undefined> {
  const j = jobFromArg(arg);
  if (j) return j;
  if (!(await guard())) return;
  const jobs = (await getJobs()).filter(filter);
  if (!jobs.length) { vscode.window.showInformationMessage('No matching jobs.'); return; }
  const pick = await vscode.window.showQuickPick(
    jobs.map(x => ({ label: `${x.id}  ${x.name}`, description: `${x.state} · ${x.partition} · ${x.where}`, x })), { placeHolder: 'Select job' });
  return pick?.x;
}

export const jobCmd = (verb: string, argv: (id: string) => [string, string[]], confirm?: string, filter?: (j: Job) => boolean) =>
  async (arg: unknown) => {
    const j = await pickJob(arg, filter);
    if (!j) return;
    if (confirm && !(await vscode.window.showWarningMessage(`${confirm} ${j.id} (${j.name})?`, { modal: true }, verb))) return;
    const [cmd, args] = argv(j.id);
    try { await rr(cmd, args); vscode.window.setStatusBarMessage(`Arc: ${verb.toLowerCase()} ${j.id}`, 4000); }
    catch (e) { vscode.window.showErrorMessage(`${verb} ${j.id}: ${errMsg(e)}`); }
    refreshAll();
  };

export async function jobDetails(arg: unknown) {
  const j = await pickJob(arg);
  if (j) await showText(`scontrol show job ${j.id}`, await rr('scontrol', ['show', 'job', j.id]));
}

export const efficiencyText = (id: string) =>
  rr('sacct', ['-j', id, '--format=JobID,JobName%20,Partition,Elapsed,State,AllocCPUS,TotalCPU,ReqMem,MaxRSS,ExitCode']);
export async function jobEfficiency(arg: unknown) {
  const j = await pickJob(arg);
  if (j) await showText(`sacct ${j.id}`, await efficiencyText(j.id));
}

export async function jobLog(arg: unknown) {
  const j = await pickJob(arg);
  if (!j) return;
  const f = await scontrolField(j.id, 'StdOut').catch(() => undefined);
  if (!f) { vscode.window.showWarningMessage(`No StdOut path for ${j.id} (finished jobs drop out of scontrol).`); return; }
  const u = arcUri(f);
  if (u) { await vscode.window.showTextDocument(u, { preview: true }); return; }
  await showText(`${f} (last 2000 lines)`, await rr('tail', ['-n', '2000', f]).catch(e => errMsg(e)));
}

/** Shell snippet that follows job $id's StdOut. Avoids ${…} so VS Code task variables never collide. */
export const FOLLOW_SNIPPET =
  `f=$(scontrol show job "$id" | tr ' ' '\\n' | sed -n 's/^StdOut=//p'); ` +
  `echo "==> arc: following job $id: $f"; ` +
  `while [ -n "$f" ] && [ ! -e "$f" ]; do sleep 2; done; tail -n 200 -F "$f"`;

export function followLog(id: string) {
  arcTerminal(`log ${id}`, `id=${id}; ${FOLLOW_SNIPPET}`);
}
export async function followLogCmd(arg: unknown) {
  const j = await pickJob(arg);
  if (j) followLog(j.id);
}

export async function jobShellCmd(arg: unknown) {
  const j = await pickJob(arg, x => x.state === 'RUNNING');
  if (j) attachShell(j.id);
}

export async function cancelAll() {
  if (!(await guard())) return;
  const ok = await vscode.window.showWarningMessage('Cancel ALL of your Arc jobs?', { modal: true }, 'Cancel all');
  if (ok) { await rr('scancel', ['-u', utsaId()]); refreshAll(); }
}

// ─────────────── storage ───────────────

export interface StorageDef { label: string; path: string; quotaMount?: string; purpose?: string; purge?: boolean; }
export const expandVars = (s: string) => s.replace(/\$\{user\}/g, utsaId()).replace(/\$\{home\}/g, `/home/${utsaId()}`);
export const storageDefs = (): StorageDef[] =>
  cfg().get<StorageDef[]>('storage', []).map(d => ({ ...d, path: expandVars(d.path) }));

export async function usageLine(s: StorageDef): Promise<string> {
  const script =
    `set -o pipefail; test -d ${q(s.path)} || { echo MISSING; exit 0; }; ` +
    (s.quotaMount ? `if lfs quota -q -h -u "$USER" ${q(s.quotaMount)} 2>/dev/null | tr -s ' \\n' ' '; then echo; exit 0; fi; ` : '') +
    `echo "DF $(df -hP ${q(s.path)} | tail -n1)"`;
  const t = (await runRemote(script)).trim();
  if (t === 'MISSING') return 'path not found on Arc — check arc.storage';
  if (t.startsWith('DF ')) { const f = t.slice(3).split(/\s+/); return `${f[2]} used of ${f[1]} (${f[4]}) — filesystem-level`; }
  const tok = t.split(/\s+/).filter(x => x && !x.startsWith('/'));
  return `${tok[0]} used · hard limit ${!tok[2] || tok[2] === '0k' ? 'none' : tok[2]} · ${tok[4] ?? '?'} files`;
}

export async function storageReport(): Promise<string> {
  const lines: string[] = [];
  for (const s of storageDefs()) lines.push(`${s.label.padEnd(6)} ${s.path}\n       ${s.purpose ?? ''}\n       ${await usageLine(s).catch(e => errMsg(e))}`);
  return lines.join('\n\n');
}

export async function purgeText(root: string, days: number): Promise<string> {
  const t = await runRemote(
    `find ${q(root)} -xdev -type f -atime +${days} -printf '%AY-%Am-%Ad\\t%s\\t%p\\n' 2>/dev/null | sort | head -n 5000`,
    { timeoutMs: 600_000 });
  const rows = t.trim() ? t.trim().split('\n') : [];
  const bytes = rows.reduce((a, r) => a + (Number(r.split('\t')[1]) || 0), 0);
  return `${rows.length}${rows.length === 5000 ? '+' : ''} files · ${(bytes / 1e9).toFixed(2)} GB listed ` +
    `(not accessed for > ${days} days; Arc purges at 30)\nArchive what you need: Explorer → right-click → "Arc: Archive to Vault".\n\n` +
    `last-access\tbytes\tpath\n${t}`;
}

export async function purgeScan(arg: unknown) {
  if (!(await guard())) return;
  const s = (arg as { data?: StorageDef })?.data ?? storageDefs().find(d => d.purge);
  if (!s) return;
  const days = cfg().get<number>('purgeWarnDays', 25);
  const text = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
    title: `Arc: scanning ${s.path}…` }, () => purgeText(s.path, days));
  await showText('/work purge candidates', text);
}

export function storageTerminal(arg: unknown) {
  const s = (arg as { data?: StorageDef })?.data;
  if (s) arcTerminal(`arc:${s.label}`, `cd ${q(s.path)} && exec bash -l`);
}

export function storageAdd(arg: unknown) {
  const s = (arg as { data?: StorageDef })?.data;
  if (!s) return;
  const u = arcUri(s.path);
  if (!u) { vscode.window.showWarningMessage('Adding Arc folders works from an Arc window. Use "Arc: Open Arc Workspace".'); return; }
  vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: u, name: s.label });
}

const vaultRoot = () => storageDefs().find(d => d.label === 'vault')?.path;
const workRoot = () => (storageDefs().find(d => d.purge) ?? storageDefs().find(d => d.label === 'work'))?.path;

async function rsyncTo(src: string, destDir: string, verb: string) {
  const ok = await vscode.window.showInformationMessage(`${verb}\n${src}\n→ ${destDir}/\n\n(rsync copy; the source is kept)`, { modal: true }, 'Copy');
  if (ok) arcTerminal(`arc ${verb.toLowerCase()}`, `mkdir -p ${q(destDir)} && rsync -ah --info=progress2 ${q(src)} ${q(destDir)}/ && echo "done: ${destDir}"`);
}
export async function archiveToVault(uri: vscode.Uri) {
  const src = arcPathOf(uri), v = vaultRoot(), w = workRoot();
  if (!src || !v || !w) return;
  const rel = path.posix.relative(w, src);
  const sub = rel.startsWith('..') ? '.' : path.posix.dirname(rel);
  await rsyncTo(src, sub === '.' ? path.posix.join(v, 'from-work') : path.posix.join(v, 'from-work', sub), 'Archive to vault');
}
export async function stageToWork(uri: vscode.Uri) {
  const src = arcPathOf(uri), w = workRoot();
  if (src && w) await rsyncTo(src, path.posix.join(w, 'staged'), 'Stage to /work');
}

export const whereAmI = () => windowHost();
