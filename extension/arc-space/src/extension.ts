/*
 * Arc HPC (UTSA) — Slurm & Storage
 *
 * Runs as a *workspace* extension (on Arc, inside the VS Code server), so every
 * Slurm / Lustre command executes directly on the login or compute node that
 * the Remote-SSH window is attached to. No local SSH plumbing needed here.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ───────────────────────── helpers ─────────────────────────

const cfg = () => vscode.workspace.getConfiguration('arc');
const me = () => process.env.USER || os.userInfo().username;
const host = () => os.hostname().split('.')[0];
const expand = (s: string) => s.replace(/\$\{user\}/g, me()).replace(/\$\{home\}/g, os.homedir());
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const holdName = () => cfg().get<string>('holdJobName', 'vscode');

let out: vscode.OutputChannel;

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  out.appendLine(`$ ${cmd} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr?.toString() || err.message).trim();
        out.appendLine(`  ! ${msg}`);
        reject(new Error(msg));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}
const sh = (script: string, timeoutMs?: number) => run('bash', ['-lc', script], timeoutMs);

function terminal(name: string, command: string, cwd?: string) {
  const t = vscode.window.createTerminal({ name, cwd });
  t.show();
  t.sendText(command);
  return t;
}

async function showText(title: string, body: string) {
  const doc = await vscode.workspace.openTextDocument({ content: `${title}\n${'─'.repeat(title.length)}\n\n${body}` });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Build a URI on the *current* remote for an absolute path (works in Remote-SSH windows). */
function remoteUri(p: string): vscode.Uri {
  const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.workspace.workspaceFile;
  return base ? base.with({ path: p, query: '', fragment: '' }) : vscode.Uri.file(p);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────── Slurm data ─────────────────────────

interface Partition {
  name: string; avail: string; timeLimit: string; cpus: number; memGB: number;
  gres: string; states: Map<string, number>; total: number;
}
interface NodeInfo { name: string; state: string; cpus: number; memGB: number; gres: string; }
interface Job {
  id: string; name: string; partition: string; state: string; elapsed: string;
  left: string; nodes: number; where: string; nodeList: string;
}

const baseState = (s: string) => s.replace(/[*~#!%$@^+\-]+$/, '').toLowerCase();
const leadingInt = (s: string) => parseInt(s, 10) || 0;

function gpuGres(gres: string): string | undefined {
  return gres.replace(/\([^)]*\)/g, '').split(',').map(x => x.trim()).find(x => x.startsWith('gpu'));
}

async function getPartitions(): Promise<Partition[]> {
  const hidden = new Set(cfg().get<string[]>('hiddenPartitions', []));
  const text = await run('sinfo', ['-h', '-o', '%P|%a|%l|%c|%m|%G|%t|%D']);
  const map = new Map<string, Partition>();
  for (const line of text.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 8) continue;
    const name = f[0].replace(/\*$/, '');
    if (hidden.has(name)) continue;
    let p = map.get(name);
    if (!p) {
      p = {
        name, avail: f[1], timeLimit: f[2], cpus: leadingInt(f[3]),
        memGB: Math.round(leadingInt(f[4]) / 1024), gres: f[5] === '(null)' ? '' : f[5],
        states: new Map(), total: 0,
      };
      map.set(name, p);
    }
    const st = baseState(f[6]);
    const n = Number(f[7]) || 0;
    p.states.set(st, (p.states.get(st) ?? 0) + n);
    p.total += n;
  }
  return [...map.values()];
}

async function getNodes(partition: string): Promise<NodeInfo[]> {
  const text = await run('sinfo', ['-h', '-N', '-p', partition, '-o', '%N|%t|%c|%m|%G']);
  const seen = new Map<string, NodeInfo>();
  for (const line of text.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 5) continue;
    seen.set(f[0], {
      name: f[0], state: baseState(f[1]), cpus: leadingInt(f[2]),
      memGB: Math.round(leadingInt(f[3]) / 1024), gres: f[4] === '(null)' ? '' : f[4],
    });
  }
  const rank = (s: string) => (s === 'idle' ? 0 : s === 'mix' ? 1 : s === 'alloc' ? 2 : 3);
  return [...seen.values()].sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

async function getJobs(): Promise<Job[]> {
  const text = await run('squeue', ['-h', '-u', me(), '-o', '%i|%j|%P|%T|%M|%L|%D|%R|%N']);
  const jobs: Job[] = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 9) continue;
    jobs.push({
      id: f[0], name: f[1], partition: f[2], state: f[3], elapsed: f[4],
      left: f[5], nodes: Number(f[6]) || 0, where: f[7], nodeList: f[8],
    });
  }
  return jobs;
}

// ───────────────────────── tree plumbing ─────────────────────────

type Kids = () => Promise<Item[]>;
interface ItemOpts {
  description?: string; tooltip?: string | vscode.MarkdownString; icon?: string; color?: string;
  context?: string; kids?: Kids; data?: unknown; command?: vscode.Command; expanded?: boolean;
}
class Item extends vscode.TreeItem {
  kids?: Kids; data?: unknown;
  constructor(label: string, o: ItemOpts = {}) {
    super(label, o.kids
      ? (o.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None);
    this.description = o.description;
    this.tooltip = o.tooltip;
    if (o.icon) this.iconPath = new vscode.ThemeIcon(o.icon, o.color ? new vscode.ThemeColor(o.color) : undefined);
    this.contextValue = o.context;
    this.kids = o.kids;
    this.data = o.data;
    this.command = o.command;
  }
}
class Provider implements vscode.TreeDataProvider<Item> {
  private emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private roots: () => Promise<Item[]>) {}
  refresh() { this.emitter.fire(undefined); }
  getTreeItem(e: Item) { return e; }
  async getChildren(e?: Item): Promise<Item[]> {
    try { return e ? (e.kids ? await e.kids() : []) : await this.roots(); }
    catch (err) { return [new Item(`Error: ${errMsg(err)}`, { icon: 'error', color: 'errorForeground' })]; }
  }
}

// ───────────────────────── views ─────────────────────────

const stateIcon: Record<string, [string, string]> = {
  idle: ['pass-filled', 'charts.green'], mix: ['circle-large-filled', 'charts.yellow'],
  alloc: ['circle-filled', 'charts.red'], down: ['error', 'errorForeground'],
  drain: ['debug-pause', 'charts.orange'], drng: ['debug-pause', 'charts.orange'],
};

async function partitionItems(): Promise<Item[]> {
  const parts = await getPartitions();
  return parts.map(p => {
    const idle = p.states.get('idle') ?? 0;
    const gpu = gpuGres(p.gres);
    const table = [...p.states].map(([s, n]) => `| ${s} | ${n} |`).join('\n');
    const tip = new vscode.MarkdownString(
      `**${p.name}** (${p.avail})\n\n${p.cpus} cores · ~${p.memGB} GB · ${gpu ?? 'no GPU'} · max ${p.timeLimit}\n\n| state | nodes |\n|---|---|\n${table}\n\n` +
      `_Nodes are exclusive per user on Arc, so only **idle** nodes are allocatable._` +
      (gpu ? `\n\n⚠️ GPU jobs idle > 1 h are terminated.` : ''));
    return new Item(p.name, {
      description: `${idle}/${p.total} idle · ${p.cpus}c · ${p.memGB}G${gpu ? ' · ' + gpu : ''} · ≤${p.timeLimit}`,
      tooltip: tip,
      icon: gpu ? 'circuit-board' : 'server',
      color: idle > 0 ? 'charts.green' : 'disabledForeground',
      context: 'partition',
      data: p,
      kids: async () => (await getNodes(p.name)).map(n => {
        const [icon, color] = stateIcon[n.state] ?? ['question', 'disabledForeground'];
        return new Item(n.name, { description: `${n.state} · ${n.cpus}c · ${n.memGB}G${n.gres ? ' · ' + n.gres : ''}`, icon, color, context: 'node' });
      }),
    });
  });
}

let jobsCache: Job[] | undefined;

function jobItems(jobs: Job[]): Item[] {
  const lim = cfg().get<{ maxJobs: number; maxNodes: number }>('limits', { maxJobs: 10, maxNodes: 20 });
  const nodesUsed = jobs.filter(j => j.state === 'RUNNING').reduce((a, j) => a + j.nodes, 0);
  const header = new Item(`${jobs.length}/${lim.maxJobs} jobs · ${nodesUsed}/${lim.maxNodes} nodes`, {
    icon: 'dashboard', tooltip: 'Arc fair-use limits: 10 active jobs, 20 nodes per user; 72 h max walltime (compute2: 240 h).',
  });
  if (!jobs.length) {
    return [header, new Item('No active jobs — allocate a node', {
      icon: 'vm-connect', command: { command: 'arc.allocate', title: 'Allocate' },
    })];
  }
  const hold = holdName();
  return [header, ...jobs.map(j => {
    const running = j.state === 'RUNNING';
    const isHolder = j.name === hold;
    const icon = isHolder ? 'remote' : running ? 'play-circle' : j.state === 'PENDING' ? 'watch' : 'circle-outline';
    const color = running ? 'charts.green' : j.state === 'PENDING' ? 'charts.yellow' : undefined;
    return new Item(`${j.id}  ${j.name}`, {
      description: `${j.state.toLowerCase()} · ${j.partition} · ${j.elapsed}${running ? ` / ${j.left} left` : ''} · ${j.where}`,
      tooltip: new vscode.MarkdownString(
        `**${j.name}** (${j.id})\n\n- state: ${j.state}\n- partition: ${j.partition}\n- elapsed: ${j.elapsed}\n- time left: ${j.left}\n- nodes: ${j.nodes} (${j.nodeList || '—'})\n- reason/nodelist: ${j.where}` +
        (isHolder ? `\n\n_VS Code holder job — connect via Remote-SSH host \`${cfg().get('sshNodeHost')}\`._` : '')),
      icon, color,
      context: `job:${j.state.toLowerCase()}${isHolder ? ':holder' : ''}`,
      data: j,
      command: { command: 'arc.jobDetails', title: 'Details', arguments: [{ data: j }] },
    });
  })];
}

interface StorageDef { label: string; path: string; quotaMount?: string; purpose?: string; purge?: boolean; }
const storageDefs = () => cfg().get<StorageDef[]>('storage', []);

async function usageLine(s: StorageDef): Promise<string> {
  const p = expand(s.path);
  if (s.quotaMount) {
    try {
      const t = await run('lfs', ['quota', '-q', '-h', '-u', me(), s.quotaMount]);
      const tok = t.trim().split(/\s+/).filter(x => !x.startsWith('/'));
      const used = tok[0], hard = tok[2];
      return `${used} used · hard limit ${!hard || hard === '0k' ? 'none' : hard} · ${tok[4] ?? '?'} files`;
    } catch { /* fall through to df */ }
  }
  const t = await run('df', ['-hP', p]);
  const f = t.trim().split('\n').pop()!.split(/\s+/);
  return `${f[2]} used of ${f[1]} (${f[4]}) — filesystem-level`;
}

async function storageItems(): Promise<Item[]> {
  return storageDefs().map(s => {
    const p = expand(s.path);
    const exists = fs.existsSync(p);
    return new Item(s.label, {
      description: p,
      tooltip: new vscode.MarkdownString(`**${p}**\n\n${s.purpose ?? ''}`),
      icon: s.label === 'vault' ? 'archive' : s.purge ? 'flame' : 'home',
      color: exists ? undefined : 'errorForeground',
      context: s.purge ? 'storage:purge' : 'storage',
      data: { ...s, path: p },
      kids: async () => {
        const kids = [new Item(s.purpose ?? '', { icon: 'info' })];
        if (!exists) kids.push(new Item('Path not found on this host — check arc.storage', { icon: 'error', color: 'errorForeground' }));
        else kids.push(new Item(await usageLine(s).catch(e => `usage unavailable: ${errMsg(e)}`), { icon: 'database' }));
        return kids;
      },
    });
  });
}

// ───────────────────────── actions ─────────────────────────

function jobArg(arg: unknown): Job | undefined {
  const d = (arg as { data?: unknown })?.data;
  return d && typeof d === 'object' && 'id' in d ? (d as Job) : undefined;
}
async function pickJob(arg: unknown, filter: (j: Job) => boolean = () => true): Promise<Job | undefined> {
  const j = jobArg(arg);
  if (j) return j;
  const jobs = (await getJobs()).filter(filter);
  if (!jobs.length) { vscode.window.showInformationMessage('No matching jobs.'); return; }
  const pick = await vscode.window.showQuickPick(
    jobs.map(x => ({ label: `${x.id}  ${x.name}`, description: `${x.state} · ${x.partition} · ${x.where}`, x })),
    { placeHolder: 'Select job' });
  return pick?.x;
}

async function scontrolField(id: string, field: string): Promise<string | undefined> {
  const t = await run('scontrol', ['show', 'job', id]);
  return t.split(/\s+/).find(x => x.startsWith(`${field}=`))?.slice(field.length + 1);
}

async function choosePartition(preset?: Partition): Promise<Partition | undefined> {
  if (preset) return preset;
  const parts = (await getPartitions()).filter(p => p.avail === 'up');
  const pick = await vscode.window.showQuickPick(parts.map(p => {
    const idle = p.states.get('idle') ?? 0;
    const gpu = gpuGres(p.gres);
    return {
      label: `${idle > 0 ? '$(pass-filled)' : '$(watch)'} ${p.name}`,
      description: `${idle}/${p.total} idle`,
      detail: `${p.cpus} cores · ~${p.memGB} GB · ${gpu ?? 'no GPU'} · max ${p.timeLimit}`,
      p,
    };
  }).sort((a, b) => (b.p.states.get('idle') ?? 0) - (a.p.states.get('idle') ?? 0)),
  { placeHolder: 'Partition (sorted by idle nodes)', matchOnDetail: true });
  return pick?.p;
}

async function chooseWalltime(p: Partition): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: `Walltime for ${p.name} (max ${p.timeLimit})`,
    value: cfg().get<string>('defaultWalltime', '04:00:00'),
    validateInput: v => /^(\d+-)?\d{1,3}:\d{2}:\d{2}$/.test(v) ? undefined : 'Use HH:MM:SS or D-HH:MM:SS',
  });
}

async function gpuGuard(p: Partition): Promise<boolean> {
  if (!gpuGres(p.gres)) return true;
  const ok = await vscode.window.showWarningMessage(
    `${p.name} is a GPU partition. Arc terminates jobs whose GPUs are idle for more than 1 hour. ` +
    `Holding a GPU node just for editing will get the job killed.`,
    { modal: true }, 'Allocate anyway');
  return ok === 'Allocate anyway';
}

async function allocate(arg?: unknown) {
  const hold = holdName();
  const existing = (await getJobs()).find(j => j.name === hold);
  if (existing) {
    const a = await vscode.window.showWarningMessage(
      `A '${hold}' job already exists (${existing.id}, ${existing.state}).`, 'Connect', 'Release it', 'Cancel');
    if (a === 'Connect') return connectNode();
    if (a !== 'Release it') return;
    await run('scancel', [existing.id]);
  }
  const preset = (arg as { data?: Partition })?.data;
  const p = await choosePartition(preset && 'states' in preset ? preset : undefined);
  if (!p) return;
  const time = await chooseWalltime(p);
  if (!time || !(await gpuGuard(p))) return;

  const logDir = path.join(os.homedir(), '.arc', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const args = ['--parsable', '-J', hold, '-p', p.name, '-t', time, '-N', '1', '-n', '1',
    '-c', String(p.cpus || 1), '-o', path.join(logDir, '%x-%j.log')];
  const gpu = gpuGres(p.gres);
  if (gpu && cfg().get<boolean>('requestGpuGres', true)) args.push(`--gres=${gpu}`);
  args.push('--wrap', 'sleep infinity');

  let id: string;
  try { id = (await run('sbatch', args)).trim().split(';')[0]; }
  catch (e) { vscode.window.showErrorMessage(`sbatch failed: ${errMsg(e)}`); return; }
  refreshAll();

  const node = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, cancellable: true,
    title: `Arc: waiting for ${p.name} node (job ${id})`,
  }, async (progress, token) => {
    for (let i = 0; i < 240 && !token.isCancellationRequested; i++) {
      const [state, nodeName, reason] = (await run('squeue', ['-h', '-j', id, '-o', '%T|%N|%R']).catch(() => '')).trim().split('|');
      if (state === 'RUNNING') return nodeName;
      if (!state) throw new Error(`job ${id} left the queue — see ~/.arc/logs`);
      progress.report({ message: `${state.toLowerCase()} (${reason})` });
      await new Promise(r => setTimeout(r, 5000));
    }
    return undefined;
  }).then(n => n, e => { vscode.window.showErrorMessage(errMsg(e)); return undefined; });

  refreshAll();
  if (!node) {
    vscode.window.showInformationMessage(`Job ${id} is still queued; the status bar will show when it starts.`);
    return;
  }
  const a = await vscode.window.showInformationMessage(
    `Node ${node} is ready (job ${id}, ${time}).`, 'Open VS Code on node', 'Shell here');
  if (a === 'Open VS Code on node') await connectNode();
  if (a === 'Shell here') terminal(`arc ${node}`, `srun --jobid=${id} --overlap --pty bash -l`);
}

async function connectNode() {
  const aliasHost = cfg().get<string>('sshNodeHost', 'arc-node');
  const holder = (await getJobs()).find(j => j.name === holdName() && j.state === 'RUNNING');
  if (!holder) {
    const a = await vscode.window.showWarningMessage('No running holder job.', 'Allocate');
    if (a) await allocate();
    return;
  }
  const wf = vscode.workspace.workspaceFile;
  const target = wf && wf.scheme !== 'untitled'
    ? wf.path
    : vscode.workspace.workspaceFolders?.[0]?.uri.path ?? os.homedir();
  const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${aliasHost}${target}`);
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
}

async function releaseNode() {
  const hold = holdName();
  const ok = await vscode.window.showWarningMessage(
    `Cancel your '${hold}' job(s)? Any VS Code window on that node will disconnect.`, { modal: true }, 'Release');
  if (ok) { await run('scancel', ['-u', me(), `--name=${hold}`]); refreshAll(); }
}

async function interactiveShell() {
  const p = await choosePartition();
  if (!p) return;
  const time = await chooseWalltime(p);
  if (!time || !(await gpuGuard(p))) return;
  const gpu = gpuGres(p.gres);
  terminal(`srun ${p.name}`,
    `srun -p ${p.name} -n 1 -t ${time} -c ${p.cpus || 1}${gpu ? ` --gres=${gpu}` : ''} --pty bash -l`);
}

async function submitBatch(uri?: vscode.Uri) {
  const file = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!file) return;
  try { await vscode.workspace.save(file); } catch { /* not open or untitled */ }
  try {
    const id = (await run('bash', ['-lc', `cd ${q(path.posix.dirname(file.path))} && sbatch --parsable ${q(file.path)}`])).trim().split(';')[0];
    vscode.window.showInformationMessage(`Submitted ${path.posix.basename(file.path)} → job ${id}`);
    refreshAll();
  } catch (e) { vscode.window.showErrorMessage(`sbatch: ${errMsg(e)}`); }
}

const jobCmd = (verb: string, argv: (id: string) => [string, string[]], confirm?: string, filter?: (j: Job) => boolean) =>
  async (arg: unknown) => {
    const j = await pickJob(arg, filter);
    if (!j) return;
    if (confirm && !(await vscode.window.showWarningMessage(`${confirm} ${j.id} (${j.name})?`, { modal: true }, verb))) return;
    const [cmd, args] = argv(j.id);
    try { await run(cmd, args); vscode.window.setStatusBarMessage(`Arc: ${verb.toLowerCase()} ${j.id}`, 4000); }
    catch (e) { vscode.window.showErrorMessage(`${verb} ${j.id}: ${errMsg(e)}`); }
    refreshAll();
  };

async function jobDetails(arg: unknown) {
  const j = await pickJob(arg);
  if (j) await showText(`scontrol show job ${j.id}`, await run('scontrol', ['show', 'job', j.id]));
}
async function jobEfficiency(arg: unknown) {
  const j = await pickJob(arg);
  if (!j) return;
  const t = await run('sacct', ['-j', j.id, '--format=JobID,JobName%20,Partition,Elapsed,State,AllocCPUS,TotalCPU,ReqMem,MaxRSS,ExitCode']);
  await showText(`sacct ${j.id}`, t);
}
async function jobLog(arg: unknown) {
  const j = await pickJob(arg);
  if (!j) return;
  const f = await scontrolField(j.id, 'StdOut').catch(() => undefined);
  if (!f || !fs.existsSync(f)) { vscode.window.showWarningMessage(`No readable StdOut for ${j.id} (${f ?? 'unknown'})`); return; }
  await vscode.window.showTextDocument(remoteUri(f), { preview: true });
}
async function jobShell(arg: unknown) {
  const j = await pickJob(arg, x => x.state === 'RUNNING');
  if (j) terminal(`job ${j.id}`, `srun --jobid=${j.id} --overlap --pty bash -l`);
}

function storageArg(arg: unknown): StorageDef | undefined {
  const d = (arg as { data?: StorageDef })?.data;
  return d && 'path' in d ? d : undefined;
}
async function storageTerminal(arg: unknown) {
  const s = storageArg(arg); if (s) terminal(`arc:${s.label}`, `cd ${q(s.path)} && ls`, undefined);
}
function storageAdd(arg: unknown) {
  const s = storageArg(arg); if (!s) return;
  const n = vscode.workspace.workspaceFolders?.length ?? 0;
  vscode.workspace.updateWorkspaceFolders(n, 0, { uri: remoteUri(s.path), name: s.label });
}
async function purgeScan(arg: unknown) {
  const s = storageArg(arg) ?? storageDefs().map(d => ({ ...d, path: expand(d.path) })).find(d => d.purge);
  if (!s) return;
  const days = cfg().get<number>('purgeWarnDays', 25);
  const t = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Scanning ${s.path} for files unaccessed > ${days} days…` },
    () => sh(`find ${q(s.path)} -xdev -type f -atime +${days} -printf '%AY-%Am-%Ad\\t%s\\t%p\\n' 2>/dev/null | sort | head -n 5000`, 600_000));
  const rows = t.trim() ? t.trim().split('\n') : [];
  const bytes = rows.reduce((a, r) => a + (Number(r.split('\t')[1]) || 0), 0);
  await showText(`/work purge candidates (> ${days} days since access; purge at 30)`,
    `${rows.length}${rows.length === 5000 ? '+' : ''} files · ${(bytes / 1e9).toFixed(2)} GB (listed)\n` +
    `Archive what you need: right-click in Explorer → "Arc: Archive to Vault".\n\n` +
    `last-access\tbytes\tpath\n${t}`);
}

function vaultRoot(): string | undefined {
  const v = storageDefs().find(d => d.label === 'vault');
  return v ? expand(v.path) : undefined;
}
function workRoot(): string | undefined {
  const w = storageDefs().find(d => d.purge) ?? storageDefs().find(d => d.label === 'work');
  return w ? expand(w.path) : undefined;
}
async function rsyncTo(src: string, destDir: string, verb: string) {
  const ok = await vscode.window.showInformationMessage(
    `${verb}\n${src}\n→ ${destDir}/\n\n(rsync copy; source is kept)`, { modal: true }, 'Copy');
  if (ok) terminal(`arc ${verb.toLowerCase()}`, `mkdir -p ${q(destDir)} && rsync -ah --info=progress2 ${q(src)} ${q(destDir)}/`);
}
async function archiveToVault(uri: vscode.Uri) {
  const v = vaultRoot(), w = workRoot();
  if (!uri || !v || !w) return;
  const rel = path.posix.relative(w, uri.path);
  const sub = rel.startsWith('..') ? '' : path.posix.dirname(rel);
  await rsyncTo(uri.path, path.posix.join(v, 'from-work', sub === '.' ? '' : sub), 'Archive to vault');
}
async function stageToWork(uri: vscode.Uri) {
  const w = workRoot();
  if (uri && w) await rsyncTo(uri.path, path.posix.join(w, 'staged'), 'Stage to /work');
}

// ───────────────────────── status bar + polling ─────────────────────────

let status: vscode.StatusBarItem;
let prevStates = new Map<string, Job>();
let warnedLowTime = false;

function leftMinutes(l: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(l);
  if (!m) return Infinity;
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3]);
}

function updateStatus(jobs: Job[]) {
  const h = host();
  const here = jobs.find(j => j.state === 'RUNNING' && (j.nodeList === h || j.nodeList.split(',').includes(h)));
  const holder = jobs.find(j => j.name === holdName());
  status.backgroundColor = undefined;
  if (here) {
    status.text = `$(vm-active) ${h} · ${here.left} left`;
    status.tooltip = `Compute node for job ${here.id} (${here.name}, ${here.partition})`;
    status.command = { command: 'arc.jobDetails', title: 'Details', arguments: [{ data: here }] };
    if (leftMinutes(here.left) < 15 && !warnedLowTime) {
      warnedLowTime = true;
      vscode.window.showWarningMessage(`Arc: job ${here.id} on ${h} ends in ${here.left}. Save your work.`);
    }
  } else if (holder?.state === 'RUNNING') {
    status.text = `$(vm-connect) Arc node ${holder.nodeList} ready`;
    status.tooltip = 'You are on a login node. Click to open this workspace on your allocated compute node.';
    status.command = 'arc.connectNode';
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (holder) {
    status.text = `$(watch) Arc: ${holder.state.toLowerCase()} (${holder.where})`;
    status.tooltip = `Holder job ${holder.id} waiting for a node`;
    status.command = { command: 'arc.jobDetails', title: 'Details', arguments: [{ data: holder }] };
  } else {
    status.text = `$(vm-outline) Arc: login node`;
    status.tooltip = 'Login nodes: edit, transfer, submit only — no compute/memory-heavy work. Click to allocate a compute node.';
    status.command = 'arc.allocate';
  }
  status.show();
}

function notifyTransitions(jobs: Job[]) {
  if (!cfg().get<boolean>('notifyOnJobEnd', true)) return;
  const now = new Map(jobs.map(j => [j.id, j]));
  for (const [id, old] of prevStates) {
    const cur = now.get(id);
    if (!cur) {
      vscode.window.showInformationMessage(`Arc: job ${id} (${old.name}) left the queue.`, 'Efficiency', 'Log')
        .then(a => a === 'Efficiency' ? jobEfficiency({ data: old }) : a === 'Log' ? jobLog({ data: old }) : undefined);
    } else if (old.state === 'PENDING' && cur.state === 'RUNNING') {
      vscode.window.showInformationMessage(`Arc: job ${id} (${cur.name}) started on ${cur.nodeList}.`);
    }
  }
  prevStates = now;
}

let jobsView: Provider, partView: Provider, storageView: Provider;

async function poll() {
  try {
    const jobs = await getJobs();
    jobsCache = jobs;
    notifyTransitions(jobs);
    updateStatus(jobs);
    jobsView.refresh();
  } catch (e) {
    status.text = '$(warning) Arc: Slurm unavailable';
    status.tooltip = errMsg(e);
    status.show();
  }
}
function refreshAll() {
  jobsCache = undefined;
  void poll();
  partView.refresh();
  storageView.refresh();
}

// ───────────────────────── activate ─────────────────────────

export function activate(ctx: vscode.ExtensionContext) {
  out = vscode.window.createOutputChannel('Arc HPC');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  jobsView = new Provider(async () => jobItems(jobsCache ?? await getJobs()));
  partView = new Provider(partitionItems);
  storageView = new Provider(storageItems);

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  ctx.subscriptions.push(
    out, status,
    vscode.window.registerTreeDataProvider('arc.jobs', jobsView),
    vscode.window.registerTreeDataProvider('arc.partitions', partView),
    vscode.window.registerTreeDataProvider('arc.storage', storageView),
  );

  reg('arc.refresh', refreshAll);
  reg('arc.allocate', () => allocate());
  reg('arc.allocateOn', (a) => allocate(a));
  reg('arc.connectNode', connectNode);
  reg('arc.releaseNode', releaseNode);
  reg('arc.interactiveShell', interactiveShell);
  reg('arc.submitBatch', submitBatch);

  reg('arc.jobDetails', jobDetails);
  reg('arc.jobLog', jobLog);
  reg('arc.jobShell', jobShell);
  reg('arc.jobEfficiency', jobEfficiency);
  reg('arc.jobCancel', jobCmd('Cancel', id => ['scancel', [id]], 'Cancel job'));
  reg('arc.jobHold', jobCmd('Hold', id => ['scontrol', ['hold', id]], undefined, j => j.state === 'PENDING'));
  reg('arc.jobRelease', jobCmd('Release', id => ['scontrol', ['release', id]], undefined, j => j.state === 'PENDING'));
  reg('arc.jobRequeue', jobCmd('Requeue', id => ['scontrol', ['requeue', id]], 'Requeue job', j => j.state === 'RUNNING'));
  reg('arc.cancelAll', async () => {
    const ok = await vscode.window.showWarningMessage('Cancel ALL of your Arc jobs (scancel -u $USER)?', { modal: true }, 'Cancel all');
    if (ok) { await run('scancel', ['-u', me()]); refreshAll(); }
  });

  reg('arc.storageTerminal', storageTerminal);
  reg('arc.storageAdd', storageAdd);
  reg('arc.purgeScan', purgeScan);
  reg('arc.archiveToVault', archiveToVault);
  reg('arc.stageToWork', stageToWork);

  let timer = setInterval(poll, Math.max(10, cfg().get<number>('refreshSeconds', 30)) * 1000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (!e.affectsConfiguration('arc')) return;
    clearInterval(timer);
    timer = setInterval(poll, Math.max(10, cfg().get<number>('refreshSeconds', 30)) * 1000);
    refreshAll();
  }));

  void poll();
}

export function deactivate() { /* disposables handle cleanup */ }
