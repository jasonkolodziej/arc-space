import * as vscode from 'vscode';
import { cfg, errMsg, holdName, nodeHost, windowHost, isSignedIn, utsaId, NotSignedIn, NotConfigured } from './transport';
import { getPartitions, getNodes, gpuGres, Job, leftMinutes } from './slurm';
import { storageDefs, usageLine } from './actions';

type Kids = () => Promise<Item[]>;
interface ItemOpts {
  description?: string; tooltip?: string | vscode.MarkdownString; icon?: string; color?: string;
  context?: string; kids?: Kids; data?: unknown; command?: vscode.Command;
}
export class Item extends vscode.TreeItem {
  kids?: Kids; data?: unknown;
  constructor(label: string, o: ItemOpts = {}) {
    super(label, o.kids ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.description = o.description;
    this.tooltip = o.tooltip;
    if (o.icon) this.iconPath = new vscode.ThemeIcon(o.icon, o.color ? new vscode.ThemeColor(o.color) : undefined);
    this.contextValue = o.context;
    this.kids = o.kids;
    this.data = o.data;
    this.command = o.command;
  }
}

function errorItem(e: unknown): Item {
  if (e instanceof NotConfigured) return new Item('Set up Arc…', { icon: 'gear', command: { command: 'arc.setup.all', title: 'Setup' } });
  if (e instanceof NotSignedIn) return new Item('Sign in to Arc (DUO)…', { icon: 'key', command: { command: 'arc.signIn', title: 'Sign in' } });
  return new Item(`Error: ${errMsg(e)}`, { icon: 'error', color: 'errorForeground' });
}

export class Provider implements vscode.TreeDataProvider<Item> {
  private emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private roots: () => Promise<Item[]>) {}
  refresh() { this.emitter.fire(undefined); }
  getTreeItem(e: Item) { return e; }
  async getChildren(e?: Item): Promise<Item[]> {
    try { return e ? (e.kids ? await e.kids() : []) : await this.roots(); }
    catch (err) { return [errorItem(err)]; }
  }
}

const stateIcon: Record<string, [string, string]> = {
  idle: ['pass-filled', 'charts.green'], mix: ['circle-large-filled', 'charts.yellow'],
  alloc: ['circle-filled', 'charts.red'], down: ['error', 'errorForeground'],
  drain: ['debug-pause', 'charts.orange'], drng: ['debug-pause', 'charts.orange'],
};

export async function partitionItems(): Promise<Item[]> {
  return (await getPartitions()).map(p => {
    const idle = p.states.get('idle') ?? 0;
    const gpu = gpuGres(p.gres);
    const table = [...p.states].map(([s, n]) => `| ${s} | ${n} |`).join('\n');
    return new Item(p.name, {
      description: `${idle}/${p.total} idle · ${p.cpus}c · ${p.memGB}G${gpu ? ' · ' + gpu : ''} · ≤${p.timeLimit}`,
      tooltip: new vscode.MarkdownString(
        `**${p.name}** (${p.avail})\n\n${p.cpus} cores · ~${p.memGB} GB · ${gpu ?? 'no GPU'} · max ${p.timeLimit}\n\n` +
        `| state | nodes |\n|---|---|\n${table}\n\n_Nodes are exclusive per user, so only **idle** nodes are allocatable._` +
        (gpu ? `\n\n⚠️ GPU jobs idle > 1 h are terminated.` : '')),
      icon: gpu ? 'circuit-board' : 'server', color: idle > 0 ? 'charts.green' : 'disabledForeground',
      context: 'partition', data: p,
      kids: async () => (await getNodes(p.name)).map(n => {
        const [icon, color] = stateIcon[n.state] ?? ['question', 'disabledForeground'];
        return new Item(n.name, { description: `${n.state} · ${n.cpus}c · ${n.memGB}G${n.gres ? ' · ' + n.gres : ''}`, icon, color, context: 'node' });
      }),
    });
  });
}

export function jobItems(jobs: Job[]): Item[] {
  const lim = cfg().get<{ maxJobs: number; maxNodes: number }>('limits', { maxJobs: 10, maxNodes: 20 });
  const nodesUsed = jobs.filter(j => j.state === 'RUNNING').reduce((a, j) => a + j.nodes, 0);
  const header = new Item(`${jobs.length}/${lim.maxJobs} jobs · ${nodesUsed}/${lim.maxNodes} nodes`, {
    icon: 'dashboard', tooltip: 'Arc fair-use limits: 10 active jobs and 20 nodes per user; 72 h max walltime (compute2: 240 h).' });
  if (!jobs.length) {
    return [header, new Item('No active jobs — allocate a node', { icon: 'vm-connect', command: { command: 'arc.allocate', title: 'Allocate' } })];
  }
  const hold = holdName();
  return [header, ...jobs.map(j => {
    const running = j.state === 'RUNNING';
    const isHolder = j.name === hold;
    return new Item(`${j.id}  ${j.name}`, {
      description: `${j.state.toLowerCase()} · ${j.partition} · ${j.elapsed}${running ? ` / ${j.left} left` : ''} · ${j.where}`,
      tooltip: new vscode.MarkdownString(
        `**${j.name}** (${j.id})\n\n- state: ${j.state}\n- partition: ${j.partition}\n- elapsed: ${j.elapsed}\n- time left: ${j.left}\n` +
        `- nodes: ${j.nodes} (${j.nodeList || '—'})\n- reason/nodelist: ${j.where}` +
        (isHolder ? `\n\n_VS Code holder job — open it with Remote-SSH host \`${nodeHost()}\`._` : '')),
      icon: isHolder ? 'remote' : running ? 'play-circle' : j.state === 'PENDING' ? 'watch' : 'circle-outline',
      color: running ? 'charts.green' : j.state === 'PENDING' ? 'charts.yellow' : undefined,
      context: `job:${j.state.toLowerCase()}${isHolder ? ':holder' : ''}`,
      data: j,
      command: { command: 'arc.jobDetails', title: 'Details', arguments: [{ data: j }] },
    });
  })];
}

export async function storageItems(): Promise<Item[]> {
  if (!utsaId()) throw new NotConfigured();
  return storageDefs().map(s => new Item(s.label, {
    description: s.path,
    tooltip: new vscode.MarkdownString(`**${s.path}**\n\n${s.purpose ?? ''}`),
    icon: s.label === 'vault' ? 'archive' : s.purge ? 'flame' : 'home',
    context: s.purge ? 'storage:purge' : 'storage',
    data: s,
    kids: async () => [
      new Item(s.purpose ?? '', { icon: 'info' }),
      new Item(await usageLine(s).catch(e => `usage unavailable: ${errMsg(e)}`), { icon: 'database' }),
    ],
  }));
}

// ─────────────── status bar ───────────────

let warnedLowTime = false;

export async function statusFor(status: vscode.StatusBarItem, jobs: Job[] | undefined, err?: unknown) {
  status.backgroundColor = undefined;
  if (!utsaId()) {
    status.text = '$(gear) Arc: set up'; status.command = 'arc.setup.all'; status.tooltip = 'Run the Arc setup'; return status.show();
  }
  if (err instanceof NotSignedIn || (!jobs && !(await isSignedIn()))) {
    status.text = '$(key) Arc: sign in'; status.command = 'arc.signIn'; status.tooltip = 'Open the DUO sign-in (one prompt; reused ~10 h)'; return status.show();
  }
  if (!jobs) { status.text = '$(warning) Arc'; status.tooltip = errMsg(err); status.command = 'arc.refresh'; return status.show(); }

  const holder = jobs.find(j => j.name === holdName());
  const w = windowHost();
  if (w === 'node' && holder?.state === 'RUNNING') {
    status.text = `$(vm-active) ${holder.nodeList} · ${holder.left} left`;
    status.tooltip = `This window runs on compute node ${holder.nodeList} (job ${holder.id}, ${holder.partition})`;
    status.command = { command: 'arc.jobDetails', title: 'Details', arguments: [{ data: holder }] };
    if (leftMinutes(holder.left) < 15 && !warnedLowTime) {
      warnedLowTime = true;
      vscode.window.showWarningMessage(`Arc: your node's job ends in ${holder.left}. Save your work.`, 'Start a new session')
        .then(a => { if (a) void vscode.commands.executeCommand('arc.startSession'); });
    }
  } else if (w === 'node') {
    status.text = '$(error) Arc: node job ended — start new session'; status.tooltip = 'Your node job ended. Click to allocate a node and reopen this window on it.';
    status.command = 'arc.startSession'; status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (holder?.state === 'RUNNING') {
    status.text = `$(vm-connect) Arc node ${holder.nodeList} ready`;
    status.tooltip = 'Click to reopen this window on your compute node';
    status.command = 'arc.startSession';
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (holder) {
    status.text = `$(watch) Arc: ${holder.state.toLowerCase()} (${holder.where})`;
    status.tooltip = `Holder job ${holder.id} is waiting for a node`;
    status.command = { command: 'arc.jobDetails', title: 'Details', arguments: [{ data: holder }] };
  } else {
    status.text = '$(rocket) Arc: start session';
    status.tooltip = 'Allocate a compute node and reopen this window on it (one window).';
    status.command = 'arc.startSession';
  }
  status.show();
}
