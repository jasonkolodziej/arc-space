/*
 * Task type "arc". Provided tasks appear under Run Task → arc; any of them can be
 * pinned in tasks.json with parameters, bound to keys, or chained with dependsOn:
 *
 *   { "type": "arc", "action": "allocate", "partition": "compute2", "walltime": "08:00:00" }
 *   { "type": "arc", "action": "submitAndFollow", "problemMatcher": "$arc-python-watch" }
 *
 * Streaming actions run as real shell commands (on Arc directly, or via `ssh -t` from a
 * local window); the rest reuse the extension's own logic in a pseudoterminal.
 */
import * as vscode from 'vscode';
import { shellFor, onArc, errMsg, cfg } from './transport';
import {
  allocate, releaseNodeQuiet, storageReport, purgeText, efficiencyText, storageDefs, FOLLOW_SNIPPET, choosePartition,
  interactiveScript,
} from './actions';

export interface ArcTaskDef extends vscode.TaskDefinition {
  action: 'partitions' | 'idle' | 'jobs' | 'watchJobs' | 'allocate' | 'release' | 'interactive' |
          'submit' | 'submitAndFollow' | 'followLog' | 'efficiency' | 'storage' | 'purgeScan';
  partition?: string; walltime?: string; jobId?: string; file?: string;
}

const LABELS: Record<ArcTaskDef['action'], string> = {
  partitions: 'Partitions & node states', idle: 'Idle nodes by partition', jobs: 'My jobs', watchJobs: 'Watch my jobs',
  allocate: 'Allocate VS Code node', release: 'Release VS Code node', interactive: 'Interactive shell (srun --pty)',
  submit: 'Submit current batch script', submitAndFollow: 'Submit current script & follow log', followLog: 'Follow latest job log',
  efficiency: 'Job efficiency (sacct)', storage: 'Storage usage', purgeScan: '/work purge candidates',
};
const ARC_ONLY: ArcTaskDef['action'][] = ['submit', 'submitAndFollow'];     // need ${file} to be a path on Arc
const BACKGROUND: ArcTaskDef['action'][] = ['watchJobs', 'followLog', 'submitAndFollow'];

const SH = /^[\w.:+-]+$/; // safe token for jobId / partition / walltime inside shell snippets

class Pty implements vscode.Pseudoterminal {
  private w = new vscode.EventEmitter<string>(); onDidWrite = this.w.event;
  private c = new vscode.EventEmitter<number>(); onDidClose = this.c.event;
  private cts = new vscode.CancellationTokenSource();
  constructor(private fn: (log: (s: string) => void, token: vscode.CancellationToken) => Promise<void>) {}
  open() {
    const log = (s: string) => this.w.fire(s.replace(/\r?\n/g, '\r\n') + '\r\n');
    this.fn(log, this.cts.token).then(
      () => { log('\x1b[2m— done —\x1b[0m'); this.c.fire(0); },
      e => { log(`\x1b[31m${errMsg(e)}\x1b[0m`); this.c.fire(1); });
  }
  close() { this.cts.cancel(); }
}
const custom = (fn: ConstructorParameters<typeof Pty>[0]) => new vscode.CustomExecution(async () => new Pty(fn));

function shellScript(d: ArcTaskDef): string | undefined {
  const job = d.jobId && SH.test(d.jobId) ? d.jobId : '';
  switch (d.action) {
    case 'partitions': return `sinfo -o "%.12P %.5a %.11l %.6D %.9t %.5c %.8m %.22G"`;
    case 'idle': return `echo "Idle (allocatable) nodes — nodes are exclusive per user:"; ` +
      `sinfo -h -t idle -o "%P %D" | awk '{a[$1]+=$2} END {for (p in a) printf "  %-12s %3d idle\\n", p, a[p]}' | sort`;
    case 'jobs': return `squeue -u "$USER" -o "%.10i %.10P %.22j %.9T %.10M %.10L %.4D %R"; ` +
      `echo "— $(squeue -u "$USER" -h | wc -l) / 10 active jobs (fair-use limit)"`;
    case 'watchJobs': return `watch -n 15 squeue -u "$USER"`;
    case 'submit': return `cd "$(dirname "${d.file ?? '${file}'}")" && sbatch "${d.file ?? '${file}'}"`;
    case 'submitAndFollow': return `cd "$(dirname "${d.file ?? '${file}'}")" && raw=$(sbatch --parsable "${d.file ?? '${file}'}") && ` +
      `id=$(echo "$raw" | cut -d';' -f1) && echo "submitted job $id" && ${FOLLOW_SNIPPET}`;
    case 'followLog': return (job ? `id=${job}; ` : `id=$(squeue -u "$USER" -h -o %i --sort=-V | head -n1); ` +
      `[ -n "$id" ] || { echo "no active jobs"; exit 1; }; `) + FOLLOW_SNIPPET;
    default: return undefined;
  }
}

function customFor(d: ArcTaskDef): vscode.CustomExecution | undefined {
  switch (d.action) {
    case 'allocate': return custom(async (log, token) => {
      if (d.partition && !SH.test(d.partition)) throw new Error('bad partition');
      await allocate({ partition: d.partition, walltime: d.walltime, report: log, token });
    });
    case 'release': return custom(async log => { log(await releaseNodeQuiet()); });
    case 'storage': return custom(async log => { log(await storageReport()); });
    case 'purgeScan': return custom(async log => {
      const w = storageDefs().find(s => s.purge);
      if (!w) throw new Error('no purge-tracked storage in arc.storage');
      log(`scanning ${w.path}…`);
      log(await purgeText(w.path, cfg().get<number>('purgeWarnDays', 25)));
    });
    case 'efficiency': return custom(async log => {
      if (!d.jobId || !SH.test(d.jobId)) throw new Error('set "jobId" in the task definition (or use the job view)');
      log(await efficiencyText(d.jobId));
    });
    case 'interactive': return undefined; // needs a real TTY → shell (resolved lazily below)
    default: return undefined;
  }
}

export function buildTask(d: ArcTaskDef, scope: vscode.WorkspaceFolder | vscode.TaskScope = vscode.TaskScope.Workspace,
  interactiveCmd?: string): vscode.Task {
  const label = LABELS[d.action] ?? d.action;
  let exec: vscode.ShellExecution | vscode.CustomExecution;
  const matchers: string[] = [];
  try {
    if (ARC_ONLY.includes(d.action) && !onArc() && !d.file) throw new Error('Submitting needs an Arc window (the script must live on Arc).');
    const script = d.action === 'interactive' ? interactiveCmd : shellScript(d);
    if (script) {
      exec = new vscode.ShellExecution(shellFor(script));
      if (d.action === 'submitAndFollow' || d.action === 'followLog') matchers.push('$arc-python-watch');
    } else {
      exec = customFor(d) ?? custom(async () => { throw new Error(`Unknown or incomplete arc task "${d.action}"`); });
    }
  } catch (e) {
    exec = custom(async () => { throw e; });
  }
  const t = new vscode.Task(d, scope, label, 'arc', exec, matchers);
  t.isBackground = BACKGROUND.includes(d.action);
  t.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  return t;
}

export class ArcTaskProvider implements vscode.TaskProvider {
  static readonly type = 'arc';
  provideTasks(): vscode.Task[] {
    const actions = (Object.keys(LABELS) as ArcTaskDef['action'][])
      .filter(a => a !== 'interactive' && a !== 'efficiency' && (onArc() || !ARC_ONLY.includes(a)));
    const tasks = actions.map(action => buildTask({ type: 'arc', action }));
    const p = cfg().get<string>('defaultPartition', 'compute1');
    tasks.push(buildTask({ type: 'arc', action: 'interactive', partition: p },
      vscode.TaskScope.Workspace, `srun -p ${p} -n 1 -t ${cfg().get<string>('defaultWalltime', '04:00:00')} --pty bash -l`));
    return tasks;
  }
  async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
    const d = task.definition as ArcTaskDef;
    if (!d.action) return undefined;
    const scope = (task.scope ?? vscode.TaskScope.Workspace) as vscode.WorkspaceFolder | vscode.TaskScope;
    if (d.action === 'interactive') {
      const name = d.partition ?? cfg().get<string>('defaultPartition', 'compute1');
      const time = d.walltime ?? cfg().get<string>('defaultWalltime', '04:00:00');
      if (!SH.test(name) || !SH.test(time)) return buildTask(d, scope); // → reports "incomplete arc task"
      const p = await choosePartition(name).catch(() => undefined);
      return buildTask(d, scope, p ? interactiveScript(p, time) : `srun -p ${name} -n 1 -t ${time} --pty bash -l`);
    }
    return buildTask(d, scope);
  }
}
