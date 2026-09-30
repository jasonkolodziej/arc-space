/*
 * Arc HPC (UTSA) — v0.2
 * Runs on your Mac (extensionKind "ui"): sets up SSH/settings, then drives Slurm and
 * storage on Arc over the multiplexed SSH connection. Works in local, login-node and
 * compute-node windows alike.
 */
import * as vscode from 'vscode';
import { initTransport, errMsg, NotSignedIn, NotConfigured, isSignedIn, utsaId } from './transport';
import { getJobs, Job } from './slurm';
import { Provider, jobItems, partitionItems, storageItems, statusFor } from './views';
import * as A from './actions';
import * as S from './setup';
import { ArcTaskProvider } from './tasks';
import { MonitorPanel } from './monitor';
import { registerReports } from './docs';

let status: vscode.StatusBarItem;
let jobsView: Provider, partView: Provider, storageView: Provider;
let jobsCache: Job[] | undefined;
let prev = new Map<string, Job>();
let firstPoll = true;

function notifyTransitions(jobs: Job[]) {
  const now = new Map(jobs.map(j => [j.id, j]));
  if (!firstPoll && vscode.workspace.getConfiguration('arc').get<boolean>('notifyOnJobEnd', true)) {
    for (const [id, old] of prev) {
      const cur = now.get(id);
      if (!cur && old.name !== 'arc-verify') {
        vscode.window.showInformationMessage(`Arc: job ${id} (${old.name}) left the queue.`, 'Efficiency')
          .then(a => { if (a) void A.jobEfficiency({ data: old }); });
      } else if (cur && old.state === 'PENDING' && cur.state === 'RUNNING') {
        vscode.window.showInformationMessage(`Arc: job ${id} (${cur.name}) started on ${cur.nodeList}.`);
      }
    }
  }
  prev = now;
  firstPoll = false;
}

async function poll() {
  if (!utsaId() || !(await isSignedIn())) {
    jobsCache = undefined;
    await statusFor(status, undefined);
    jobsView.refresh();
    return;
  }
  try {
    const jobs = await getJobs();
    jobsCache = jobs;
    notifyTransitions(jobs);
    await statusFor(status, jobs);
  } catch (e) {
    jobsCache = undefined;
    await statusFor(status, undefined, e);
  }
  jobsView.refresh();
}

function refreshAll() {
  void poll();
  partView.refresh();
  storageView.refresh();
  void S.refreshSetupContext();
}

async function jobsRoot() {
  if (!utsaId()) throw new NotConfigured();
  if (jobsCache) return jobItems(jobsCache);
  if (!(await isSignedIn())) throw new NotSignedIn();
  return jobItems(await getJobs());
}

export function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Arc HPC');
  initTransport(out);
  registerReports(ctx);
  S.initSetup(ctx);
  status = vscode.window.createStatusBarItem('arc.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Arc HPC';

  jobsView = new Provider(jobsRoot);
  partView = new Provider(partitionItems);
  storageView = new Provider(storageItems);
  A.setRefreshHook(refreshAll);
  A.setMemento(ctx.globalState);

  ctx.subscriptions.push(
    out, status,
    vscode.window.registerTreeDataProvider('arc.jobs', jobsView),
    vscode.window.registerTreeDataProvider('arc.partitions', partView),
    vscode.window.registerTreeDataProvider('arc.storage', storageView),
    vscode.tasks.registerTaskProvider(ArcTaskProvider.type, new ArcTaskProvider()),
  );

  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...a: any[]) => {
      try { return await fn(...a); }
      catch (e) {
        if (e instanceof NotSignedIn) {
          const x = await vscode.window.showWarningMessage(e.message, 'Sign in');
          if (x) await S.signIn();
        } else vscode.window.showErrorMessage(`Arc: ${errMsg(e)}`);
      }
    }));

  // setup
  reg('arc.setup.all', S.runFullSetup);
  reg('arc.setup.ssh', S.configureSsh);
  reg('arc.setup.userSettings', S.applyUserSettings);
  reg('arc.setup.key', S.setupKey);
  reg('arc.setup.remote', S.prepareRemote);
  reg('arc.setup.verify', S.verify);
  reg('arc.diagnoseNode', S.diagnoseNode);
  reg('arc.checkNodeEnv', S.checkNodeEnv);
  reg('arc.findVault', async () => { const c = await S.findVault(true); vscode.window.showInformationMessage(`Arc vault: ${c.detail}`); refreshAll(); });
  reg('arc.signIn', async () => { if (await S.signIn()) refreshAll(); });
  reg('arc.signOut', async () => { await S.signOut(); refreshAll(); });
  reg('arc.openWorkspace', () => S.openWorkspace(false));
  reg('arc.reviewWorkspaceSettings', () => S.reviewWorkspaceSettings());

  // compute
  reg('arc.refresh', refreshAll);
  reg('arc.allocate', () => A.allocate());
  reg('arc.allocateOn', (a: { data?: { name: string } }) => A.allocate({ partition: a?.data?.name }));
  reg('arc.connectNode', () => A.connectNode());
  reg('arc.startSession', A.startSession);
  reg('arc.releaseNode', A.releaseNode);
  reg('arc.interactiveShell', A.interactiveShell);
  reg('arc.submitBatch', A.submitBatch);

  // monitor
  reg('arc.monitor', () => MonitorPanel.show(ctx));
  reg('arc.monitorJob', (a: { data?: { id: string } }) => MonitorPanel.show(ctx, a?.data?.id));

  // jobs
  reg('arc.jobDetails', A.jobDetails);
  reg('arc.jobLog', A.jobLog);
  reg('arc.jobFollow', A.followLogCmd);
  reg('arc.jobShell', A.jobShellCmd);
  reg('arc.jobEfficiency', A.jobEfficiency);
  reg('arc.jobCancel', A.jobCmd('Cancel', id => ['scancel', [id]], 'Cancel job'));
  reg('arc.jobHold', A.jobCmd('Hold', id => ['scontrol', ['hold', id]], undefined, j => j.state === 'PENDING'));
  reg('arc.jobRelease', A.jobCmd('Release', id => ['scontrol', ['release', id]], undefined, j => j.state === 'PENDING'));
  reg('arc.jobRequeue', A.jobCmd('Requeue', id => ['scontrol', ['requeue', id]], 'Requeue job', j => j.state === 'RUNNING'));
  reg('arc.cancelAll', A.cancelAll);

  // storage
  reg('arc.storageTerminal', A.storageTerminal);
  reg('arc.storageAdd', A.storageAdd);
  reg('arc.purgeScan', A.purgeScan);
  reg('arc.archiveToVault', A.archiveToVault);
  reg('arc.stageToWork', A.stageToWork);

  // polling
  const period = () => Math.max(10, vscode.workspace.getConfiguration('arc').get<number>('refreshSeconds', 30)) * 1000;
  let timer = setInterval(poll, period());
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('arc.sshLoginHost') || e.affectsConfiguration('arc.sshNodeHost') || e.affectsConfiguration('arc.utsaId') || e.affectsConfiguration('arc.holdJobName') || e.affectsConfiguration('arc.proxyMode')) {
      try { S.writeManagedSshFiles(); } catch (err) { out.appendLine(`ssh files: ${errMsg(err)}`); }
    }
    if (e.affectsConfiguration('arc')) {
      clearInterval(timer);
      timer = setInterval(poll, period());
      refreshAll();
    }
  }));

  const ver = String(ctx.extension.packageJSON.version);
  if (utsaId() && ctx.globalState.get('arc.sshFilesVersion') !== ver) {
    try { S.writeManagedSshFiles(); void ctx.globalState.update('arc.sshFilesVersion', ver); out.appendLine(`managed ssh files refreshed for ${ver}`); }
    catch (e) { out.appendLine(`could not refresh ssh files: ${errMsg(e)}`); }
  }
  void S.refreshSetupContext();
  void poll();
  void S.maybePromptWorkspaceReview();
  if (!utsaId() && !ctx.globalState.get('arc.walkthroughShown')) {
    void ctx.globalState.update('arc.walkthroughShown', true);
    void vscode.commands.executeCommand('workbench.action.openWalkthrough', 'local.arc-slurm#arc.setup', false);
  }
}

export function deactivate() { MonitorPanel.current?.dispose(); }
