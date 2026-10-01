import * as vscode from 'vscode';
import * as path from 'path';
import {
  cfg, rr, runRemote, q, errMsg, utsaId, holdName, nodeHost, arcTerminal, loginTerminal, arcUri, onArc, windowHost, sleep,
} from './transport';
import { getPartitions, getJobs, gpuGres, Partition, Job, submitHolder, scontrolField } from './slurm';
import { ensureSignedIn, workspacePath } from './setup';
import { showReport } from './docs';

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

const showText = (title: string, body: string, key?: string) => showReport(title, body, key);

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

let memo: vscode.Memento | undefined;
export const setMemento = (m: vscode.Memento) => { memo = m; };
interface LastAlloc { partition: string; walltime: string; }

export async function allocate(o: { partition?: string; walltime?: string; report?: Report; token?: vscode.CancellationToken; afterReady?: 'ask' | 'none' } = {}): Promise<string | undefined> {
  if (!(await guard())) return;
  const report = o.report ?? (() => undefined);
  const hold = holdName();
  const existing = (await getJobs()).find(j => j.name === hold);
  if (existing) {
    const a = await vscode.window.showWarningMessage(
      `A '${hold}' job already exists (${existing.id}, ${existing.state}).`, 'Open on node', 'Replace it', 'Cancel');
    if (a === 'Open on node') { await connectNode(); return; }
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
  await memo?.update('arc.lastAlloc', { partition: p.name, walltime: time } as LastAlloc);
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
  if (o.afterReady === 'none') return node;

  const canSsh = cfg().get<boolean | null>('nodeSshAvailable', null) !== false;
  const a = await vscode.window.showInformationMessage(`Node ${node} is ready (job ${id}, ${time}).`,
    ...(canSsh ? ['Open VS Code on node'] : []), 'Attach shell');
  if (a === 'Open VS Code on node') await connectNode();
  if (a === 'Attach shell') attachShell(id);
  return node;
}

/**
 * One window, one command: sign in → reuse or allocate your node → reopen THIS window on it.
 * The Arc views, monitor and vault actions keep working after the reload because the
 * extension runs on your Mac and reaches Arc over the multiplexed SSH connection.
 */
export async function startSession() {
  if (!(await guard())) return;
  const hold = holdName();
  const holder = (await getJobs()).find(j => j.name === hold);

  if (holder?.state === 'PENDING') {
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
      title: `Arc: your node request ${holder.id} is queued (${holder.where})…` },
      async (_p, tok) => { for (let i = 0; i < 360 && !tok.isCancellationRequested; i++) {
        const st = (await rr('squeue', ['-h', '-j', holder.id, '-o', '%T']).catch(() => '')).trim();
        if (st === 'RUNNING') return true; if (!st) return false; await sleep(5000); } return false; });
    if (!ok) return;
  } else if (!holder) {
    const last = memo?.get<LastAlloc>('arc.lastAlloc');
    let preset: LastAlloc | undefined;
    if (last) {
      const parts = await getPartitions().catch(() => []);
      const idle = parts.find(p => p.name === last.partition)?.states.get('idle') ?? 0;
      const pick = await vscode.window.showQuickPick([
        { label: `$(history) ${last.partition} · ${last.walltime}`, description: `${idle} idle now`, detail: 'Same as last time', v: last },
        { label: '$(list-selection) Choose partition and walltime…', v: undefined },
      ], { title: 'Arc: start a compute-node session', ignoreFocusOut: true });
      if (!pick) return;
      preset = pick.v;
    }
    const node = await allocate({ partition: preset?.partition, walltime: preset?.walltime, afterReady: 'none' });
    if (!node) return;
  }
  await connectNode(true);
}

export async function connectNode(sameWindow?: boolean) {
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
  // Compute nodes get their own workspace (no vault folder). Check it exists before opening.
  const nodeWs = workspacePath(true);
  const exists = (await runRemote(`test -f ${q(nodeWs)} && echo 1 || echo 0`)).trim() === '1';
  let target = nodeWs;
  if (!exists) {
    const a = await vscode.window.showWarningMessage(`${nodeWs} doesn't exist yet.`, 'Create it (Prepare Arc)', 'Open home folder instead');
    if (a === 'Create it (Prepare Arc)') { await vscode.commands.executeCommand('arc.setup.remote'); }
    else if (a === 'Open home folder instead') { target = `/home/${utsaId()}`; }
    else return;
  }
  await vscode.commands.executeCommand('vscode.openFolder',
    vscode.Uri.parse(`vscode-remote://ssh-remote+${nodeHost()}${target}`),
    { forceNewWindow: !(sameWindow ?? cfg().get<string>('openNodeIn', 'sameWindow') === 'sameWindow') });
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
  if (j) await showText(`scontrol show job ${j.id}`, await rr('scontrol', ['show', 'job', j.id]), `scontrol-${j.id}`);
}

export const efficiencyText = (id: string) =>
  rr('sacct', ['-j', id, '--format=JobID,JobName%20,Partition,Elapsed,State,AllocCPUS,TotalCPU,ReqMem,MaxRSS,ExitCode']);
export async function jobEfficiency(arg: unknown) {
  const j = await pickJob(arg);
  if (j) await showText(`sacct ${j.id}`, await efficiencyText(j.id), `sacct-${j.id}`);
}

export async function jobLog(arg: unknown) {
  const j = await pickJob(arg);
  if (!j) return;
  const f = await scontrolField(j.id, 'StdOut').catch(() => undefined);
  if (!f) { vscode.window.showWarningMessage(`No StdOut path for ${j.id} (finished jobs drop out of scontrol).`); return; }
  const u = arcUri(f);
  if (u) { await vscode.window.showTextDocument(u, { preview: true }); return; }
  await showText(`${f} (last 2000 lines)`, await rr('tail', ['-n', '2000', f]).catch(e => errMsg(e)), `log-${j.id}`);
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
  await showText('/work purge candidates', text, 'purge-scan');
}

const loginOnly = (p: string) => p.startsWith('/vault/');

export function storageTerminal(arg: unknown) {
  const s = (arg as { data?: StorageDef })?.data;
  if (!s) return;
  const script = `cd ${q(s.path)} && exec bash -l`;
  if (loginOnly(s.path)) void loginTerminal(`arc:${s.label} (login)`, script); else arcTerminal(`arc:${s.label}`, script);
}

export function storageAdd(arg: unknown) {
  const s = (arg as { data?: StorageDef })?.data;
  if (!s) return;
  if (loginOnly(s.path) && windowHost() === 'node') {
    vscode.window.showWarningMessage('The vault is mounted on the login nodes only, so it can\'t be a folder in a compute-node window. Use the login window, or Archive to Vault from /work.');
    return;
  }
  const u = arcUri(s.path);
  if (!u) { vscode.window.showWarningMessage('Adding Arc folders works from an Arc window. Use "Arc: Open Arc Workspace".'); return; }
  vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: u, name: s.label });
}

const vaultRoot = () => storageDefs().find(d => d.label === 'vault')?.path;
const workRoot = () => (storageDefs().find(d => d.purge) ?? storageDefs().find(d => d.label === 'work'))?.path;

async function rsyncTo(src: string, destDir: string, verb: string) {
  const ok = await vscode.window.showInformationMessage(`${verb}\n${src}\n→ ${destDir}/\n\n(rsync copy; the source is kept)`, { modal: true }, 'Copy');
  if (!ok) return;
  const script = `mkdir -p ${q(destDir)} && rsync -ah --info=progress2 ${q(src)} ${q(destDir)}/ && echo "done: ${destDir}"`;
  // Anything touching /vault must run where /vault is mounted: the login node.
  if (loginOnly(src) || loginOnly(destDir)) await loginTerminal(`arc ${verb.toLowerCase()} (login)`, script);
  else arcTerminal(`arc ${verb.toLowerCase()}`, script);
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

// ─────────────── checkpoint signalling (remote/ckpt, arc_ckpt.py) ───────────────

const CKPT_DIR = '${ARC_CKPT_STATE_DIR:-$HOME/.arc/ckpt}';
const JOB_ID = /^\d+(_\d+)?$/;

/**
 * Ask a running training job to checkpoint. USR2 = save and keep going; USR1 = save and
 * exit (the same signal `#SBATCH --signal=B:USR1@600` sends before the walltime).
 * `scancel --full` reaches the batch shell and every step, however the trainer was launched.
 * A trainer started by hand in a terminal on the holder node isn't in a step, so for the
 * holder (or when the signal fails) a request file is left for the guard to poll (≤15 s).
 */
async function sendCheckpoint(j: Job, mode: 'save' | 'stop', noResume = false): Promise<void> {
  if (!JOB_ID.test(j.id)) throw new Error(`Unexpected job id "${j.id}"`);
  const sig = mode === 'save' ? 'USR2' : 'USR1';
  const file = `touch "$d/${j.id}.${mode}"`;
  await runRemote(
    `d="${CKPT_DIR}"; mkdir -p "$d"; ${noResume ? `touch "$d/${j.id}.noresume"; ` : ''}` +
    (j.name === holdName() ? file : `scancel --full --signal=${sig} ${j.id} || ${file}`));
}

export async function jobCheckpointSave(arg: unknown) {
  const j = await pickJob(arg, x => x.state === 'RUNNING');
  if (!j) return;
  try {
    await sendCheckpoint(j, 'save');
    vscode.window.showInformationMessage(`Arc: asked ${j.id} (${j.name}) to checkpoint and keep running.`, 'Status')
      .then(a => { if (a) void jobCheckpointStatus({ data: j }); });
  } catch (e) { vscode.window.showErrorMessage(`Checkpoint ${j.id}: ${errMsg(e)}`); }
}

export async function jobCheckpointStop(arg: unknown) {
  const j = await pickJob(arg, x => x.state === 'RUNNING');
  if (!j) return;
  if (j.name === holdName()) {  // trainer started by hand on your node: nothing to resubmit
    try { await sendCheckpoint(j, 'stop', true); vscode.window.setStatusBarMessage(`Arc: asked training on ${j.nodeList} to checkpoint and stop`, 6000); }
    catch (e) { vscode.window.showErrorMessage(`Checkpoint ${j.id}: ${errMsg(e)}`); }
    return;
  }
  const pick = await vscode.window.showQuickPick([
    { label: '$(debug-restart) Checkpoint, stop, and resume', detail: 'Exit 99 → the job requeues itself and continues from the checkpoint', noResume: false },
    { label: '$(debug-stop) Checkpoint and stop for good', detail: 'Saves, then exits 0 — no resubmission', noResume: true },
  ], { placeHolder: `${j.id} (${j.name}) · ${j.left} left` });
  if (!pick) return;
  try {
    await sendCheckpoint(j, 'stop', pick.noResume);
    vscode.window.setStatusBarMessage(`Arc: ${j.id} will checkpoint and stop`, 6000);
  } catch (e) { vscode.window.showErrorMessage(`Checkpoint ${j.id}: ${errMsg(e)}`); }
  refreshAll();
}

interface CkptStatus {
  job_id: string; host: string; state: string; reason: string; updated: number;
  end_time: number | null; restart_count: number;
  last_save: { time: number; step: unknown; path: string | null } | null;
}

export async function readCheckpointStatus(id: string): Promise<CkptStatus | undefined> {
  if (!JOB_ID.test(id)) return undefined;
  const t = await runRemote(`cat "${CKPT_DIR}/${id}.json" 2>/dev/null || true`);
  try { return t.trim() ? JSON.parse(t) as CkptStatus : undefined; } catch { return undefined; }
}

export async function jobCheckpointStatus(arg: unknown) {
  const j = await pickJob(arg);
  if (!j) return;
  const s = await readCheckpointStatus(j.id).catch(() => undefined);
  if (!s) {
    vscode.window.showInformationMessage(
      `No checkpoint status for ${j.id}. Jobs report it when the trainer uses arc_ckpt.Guard (see the checkpointing guide).`);
    return;
  }
  const ago = (t?: number | null) => (t ? `${Math.round((Date.now() / 1000 - t) / 60)} min ago` : 'never');
  const body = [
    `job        ${s.job_id} on ${s.host}`,
    `state      ${s.state}${s.reason ? ` — ${s.reason}` : ''}`,
    `restarts   ${s.restart_count}`,
    `time left  ${s.end_time ? `${Math.round((s.end_time - Date.now() / 1000) / 60)} min` : 'unknown'}`,
    `last save  ${ago(s.last_save?.time)}${s.last_save ? ` · step ${String(s.last_save.step)} · ${s.last_save.path ?? ''}` : ''}`,
    `updated    ${ago(s.updated)}`,
  ].join('\n');
  await showText(`Checkpoint status ${j.id}`, body, `ckpt-${j.id}`);
}

const warnedCkpt = new Set<string>();

/** Once per job: a running (non-holder) job is within arc.checkpointWarnMinutes of its walltime. */
export function warnCheckpoint(jobs: Job[], leftMinutes: (l: string) => number) {
  const mins = cfg().get<number>('checkpointWarnMinutes', 20);
  if (!mins) return;
  for (const j of jobs) {
    if (j.state !== 'RUNNING' || j.name === holdName() || warnedCkpt.has(j.id) || leftMinutes(j.left) >= mins) continue;
    warnedCkpt.add(j.id);
    vscode.window.showWarningMessage(
      `Arc: job ${j.id} (${j.name}) reaches its walltime in ${j.left}. Jobs using --signal + arc_ckpt save on their own; checkpoint now?`,
      'Checkpoint now', 'Checkpoint & stop…', 'Status')
      .then(a => {
        if (a === 'Checkpoint now') void jobCheckpointSave({ data: j });
        else if (a === 'Checkpoint & stop…') void jobCheckpointStop({ data: j });
        else if (a === 'Status') void jobCheckpointStatus({ data: j });
      });
  }
}
