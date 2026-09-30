import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cfg, loginHost, nodeHost, utsaId, holdName, q, errMsg, expandHome, spawnP, isSignedIn, runRemote, localTerminal,
  waitFor, NotSignedIn, onArc, log,
} from './transport';
import {
  includeBlock, withIncludeBlock, managedConf, proxyScript, SSH_BEGIN, SSH_END, MANAGED_CONF, PROXY_SCRIPT,
  userSettings, workspaceSettings, workspaceFile, USER_TEMPLATE_VERSION, WS_TEMPLATE_VERSION,
} from './templates';
import { reviewAndApply, planMerge, Baseline } from './merge';
import { getPartitions } from './slurm';

let ctx: vscode.ExtensionContext;
export function initSetup(c: vscode.ExtensionContext) { ctx = c; }

const S = {
  keyPath: 'arc.keyPath',
  keyInstalled: 'arc.keyInstalledFor',
  remotePrepared: 'arc.remotePreparedFor',
  verified: 'arc.verifiedFor',
  userBaseline: 'arc.userBaseline',
};
const sshConfigPath = () =>
  expandHome(vscode.workspace.getConfiguration('remote.SSH').get<string>('configFile') || '~/.ssh/config');

// ─────────────── step state (drives walkthrough checkmarks) ───────────────

export async function refreshSetupContext() {
  const id = utsaId();
  let sshOk = false;
  try { sshOk = fs.readFileSync(sshConfigPath(), 'utf8').includes(SSH_BEGIN) && fs.existsSync(expandHome(MANAGED_CONF)); } catch { /* none */ }
  const settingsOk = !planMerge(userSettings(loginHost(), nodeHost()), ctx.globalState.get<Baseline>(S.userBaseline),
    vscode.ConfigurationTarget.Global).some(c => c.kind === 'add');
  const keyOk = !!id && ctx.globalState.get(S.keyInstalled) === id;
  const signed = await isSignedIn();
  const set = (k: string, v: boolean) => vscode.commands.executeCommand('setContext', k, v);
  await Promise.all([
    set('arc.setup.ssh', sshOk), set('arc.setup.settings', settingsOk), set('arc.setup.key', keyOk),
    set('arc.setup.signedIn', signed),
    set('arc.setup.remote', !!id && ctx.globalState.get(S.remotePrepared) === id),
    set('arc.setup.verified', !!id && ctx.globalState.get(S.verified) === id),
  ]);
  return { sshOk, settingsOk, keyOk, signed };
}

// ─────────────── 1. SSH config ───────────────

async function askUtsaId(): Promise<string | undefined> {
  const cur = utsaId();
  const id = await vscode.window.showInputBox({
    title: 'Arc: myUTSA ID', prompt: 'Your myUTSA ID (e.g. abc123) — used as the SSH user on Arc',
    value: cur, ignoreFocusOut: true,
    validateInput: v => /^[a-z]{3}\d{3}$/i.test(v.trim()) ? undefined : 'Expected three letters + three digits, e.g. abc123',
  });
  if (!id) return undefined;
  const v = id.trim().toLowerCase();
  if (v !== cur) await cfg().update('utsaId', v, vscode.ConfigurationTarget.Global);
  return v;
}

function writeFileAtomic(p: string, content: string, mode: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.arc-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, p);
  fs.chmodSync(p, mode);
}

export function writeManagedSshFiles() {
  const id = utsaId();
  if (!id) return;
  const keyPath = ctx.globalState.get<string>(S.keyPath);
  writeFileAtomic(expandHome(MANAGED_CONF), managedConf({ id, login: loginHost(), node: nodeHost(), identityFile: keyPath }), 0o600);
  writeFileAtomic(expandHome(PROXY_SCRIPT), proxyScript(loginHost(), holdName()), 0o700);
}

export async function configureSsh(): Promise<boolean> {
  const id = await askUtsaId();
  if (!id) return false;
  const confPath = sshConfigPath();
  let text = '';
  try { text = fs.readFileSync(confPath, 'utf8'); } catch { /* new file */ }

  // One managed Include at the very TOP: ssh takes the first value it sees for each option,
  // so later "Host *" defaults in your config can't override the Arc settings.
  const next = withIncludeBlock(text);
  const without = next.slice(includeBlock().length);

  if (next !== text) {
    if (text && !fs.existsSync(`${confPath}.arc-backup`)) fs.copyFileSync(confPath, `${confPath}.arc-backup`);
    writeFileAtomic(confPath, next, 0o600);
  }
  writeManagedSshFiles();

  // Warn about hand-written blocks for the same aliases (e.g. from the v0.1 manual setup).
  const clash = without.split('\n').filter(l => new RegExp(`^\\s*Host\\s+.*\\b(${loginHost()}|${nodeHost()})\\b`).test(l));
  if (clash.length) {
    const a = await vscode.window.showWarningMessage(
      `Your ssh config also defines ${clash.map(c => c.trim()).join('; ')}. The managed Include comes first and wins, ` +
      `but leftover options from those blocks still apply. Remove them to avoid surprises.`, 'Open ssh config');
    if (a) await vscode.window.showTextDocument(vscode.Uri.file(confPath));
  }
  vscode.window.showInformationMessage(`Arc SSH configured: hosts "${loginHost()}" and "${nodeHost()}" (backup: ${path.basename(confPath)}.arc-backup).`);
  await refreshSetupContext();
  return true;
}

// ─────────────── 2. User settings ───────────────

export async function applyUserSettings(): Promise<boolean> {
  const n = await reviewAndApply('Arc: User settings (this Mac)', userSettings(loginHost(), nodeHost()),
    ctx.globalState.get<Baseline>(S.userBaseline), vscode.ConfigurationTarget.Global,
    b => ctx.globalState.update(S.userBaseline, b), USER_TEMPLATE_VERSION);
  await refreshSetupContext();
  return n !== undefined;
}

// ─────────────── 3. SSH key ───────────────

export async function setupKey(): Promise<boolean> {
  if (!utsaId() && !(await configureSsh())) return false;
  const candidates = ['~/.ssh/id_ed25519_arc', '~/.ssh/id_ed25519', '~/.ssh/id_ecdsa', '~/.ssh/id_rsa']
    .filter(k => fs.existsSync(expandHome(k) + '.pub'));
  const choice = await vscode.window.showQuickPick([
    ...candidates.map(k => ({ label: `$(key) Use ${k}`, key: k, gen: false })),
    { label: '$(add) Generate a dedicated key (~/.ssh/id_ed25519_arc)', key: '~/.ssh/id_ed25519_arc', gen: true },
  ], { title: 'Arc: SSH key for the login and compute-node hops', ignoreFocusOut: true });
  if (!choice) return false;

  if (choice.gen && !fs.existsSync(expandHome(choice.key))) {
    const mac = os.platform() === 'darwin';
    await localTerminal('Arc: ssh-keygen',
      `ssh-keygen -t ed25519 -f ${choice.key} -C "arc-slurm $(hostname -s)"` +
      (mac ? ` && ssh-add --apple-use-keychain ${choice.key}` : ` && ssh-add ${choice.key}`));
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
      title: 'Arc: finish ssh-keygen in the terminal (a passphrase is recommended; it is stored in your keychain)…' },
      (_p, t) => waitFor(async () => fs.existsSync(expandHome(choice.key) + '.pub'), 300_000, t));
    if (!ok) return false;
  }
  await ctx.globalState.update(S.keyPath, choice.key);
  writeManagedSshFiles();

  if (!(await ensureSignedIn())) return false;
  const pub = fs.readFileSync(expandHome(choice.key) + '.pub', 'utf8').trim();
  await runRemote(
    `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; k=$(cat); ` +
    `grep -qxF "$k" ~/.ssh/authorized_keys || printf '%s\\n' "$k" >> ~/.ssh/authorized_keys; echo ok`, { stdin: pub });
  await ctx.globalState.update(S.keyInstalled, utsaId());
  vscode.window.showInformationMessage(`Arc: ${choice.key}.pub is in Arc's authorized_keys (/home is shared with compute nodes).`);
  await refreshSetupContext();
  return true;
}

// ─────────────── 4. DUO sign-in ───────────────

export async function signIn(): Promise<boolean> {
  if (!utsaId() && !(await configureSsh())) return false;
  if (await isSignedIn()) { vscode.window.showInformationMessage('Arc: already signed in.'); await refreshSetupContext(); return true; }
  const h = loginHost();
  await localTerminal('Arc: sign in (DUO)',
    `if ssh -O check ${h} 2>/dev/null; then echo "Already signed in."; ` +
    `else ssh -fN ${h} && echo "Signed in to Arc. You can close this terminal."; fi`);
  const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
    title: 'Arc: answer the password/DUO prompt in the terminal…' },
    (_p, t) => waitFor(isSignedIn, 180_000, t));
  await refreshSetupContext();
  if (ok) vscode.window.showInformationMessage('Arc: signed in. The connection is reused for ~10 h (ControlPersist).');
  return ok;
}

export async function ensureSignedIn(): Promise<boolean> {
  if (await isSignedIn()) return true;
  const a = await vscode.window.showWarningMessage('Arc: not signed in. Sign in now (DUO)?', 'Sign in');
  return a ? signIn() : false;
}

export async function signOut() {
  await spawnP('ssh', ['-O', 'exit', loginHost()], { timeoutMs: 5000 });
  await refreshSetupContext();
  vscode.window.showInformationMessage('Arc: signed out (master connection closed).');
}

// ─────────────── 5. Prepare Arc ───────────────

export async function prepareRemote(): Promise<boolean> {
  if (!(await ensureSignedIn())) return false;
  const id = utsaId();
  const probe = await runRemote(
    `mkdir -p ~/projects ~/.arc/logs /work/$USER/.cache/{pip,uv,huggingface,torch,conda-pkgs} && ` +
    `echo "vault=$(test -d /vault/research/$USER && echo 1 || echo 0)"; ` +
    `echo "ws=$(test -e ~/.arc/arc.code-workspace && echo 1 || echo 0)"; ` +
    `echo "lfs=$(command -v lfs >/dev/null && echo 1 || echo 0)"`);
  const kv = Object.fromEntries(probe.trim().split('\n').map(l => l.split('=')));
  const notes: string[] = [];
  if (kv.ws === '1') {
    notes.push('~/.arc/arc.code-workspace already exists — left untouched (use "Arc: Review Workspace Settings" inside it).');
  } else {
    await runRemote('cat > ~/.arc/arc.code-workspace', { stdin: workspaceFile(id, kv.vault === '1') });
    notes.push('Created ~/.arc/arc.code-workspace.');
  }
  if (kv.vault !== '1') notes.push('⚠ /vault/research/<id> not found — vault folder omitted; set arc.storage if it lives elsewhere.');
  if (kv.lfs !== '1') notes.push('⚠ lfs not on PATH — storage view falls back to df.');
  await ctx.globalState.update(S.remotePrepared, id);
  vscode.window.showInformationMessage(`Arc prepared. ${notes.join(' ')}`);
  await refreshSetupContext();
  return true;
}

// ─────────────── 6. Verify ───────────────

interface Check { name: string; ok: boolean | undefined; detail: string; }

export async function verify(): Promise<boolean> {
  if (!(await ensureSignedIn())) return false;
  const checks: Check[] = [];
  const job = 'arc-verify';
  let id = '';
  try {
    const parts = await getPartitions();
    const p = ['compute1', 'compute2', 'compute3'].map(n => parts.find(x => x.name === n)).find(x => x && (x.states.get('idle') ?? 0) > 0)
      ?? parts.find(x => x.name === 'compute1') ?? parts[0];
    id = (await runRemote(`sbatch --parsable -J ${job} -p ${q(p.name)} -t 00:05:00 -N 1 -n 1 -c 1 -o /dev/null --wrap 'sleep 300'`)).trim().split(';')[0];

    const node = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
      title: `Arc: verifying — waiting for a 5-minute test job on ${p.name} (${id})…` }, async (_pr, tok) => {
      let n = '';
      await waitFor(async () => {
        const [st, nl] = (await runRemote(`squeue -h -j ${id} -o '%T|%N'`)).trim().split('|');
        if (st === 'RUNNING') { n = nl; return true; }
        return !st;                                          // vanished → stop waiting
      }, 240_000, tok, 4000);
      return n;
    });
    if (!node) {
      checks.push({ name: 'Test job started', ok: false, detail: 'Did not reach RUNNING within 4 min (queue busy?). Re-run later.' });
    } else {
      checks.push({ name: 'Test job started', ok: true, detail: `${id} on ${node}` });
      const fromLogin = await runRemote(`ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${node} hostname 2>&1; echo "rc=$?"`).catch(e => errMsg(e));
      checks.push({ name: 'Login node → compute node SSH', ok: /rc=0\s*$/.test(fromLogin), detail: fromLogin.trim().replace(/\n/g, ' ') });

      const mac = await spawnP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', nodeHost(), 'hostname'],
        { timeoutMs: 40_000, env: { ARC_HOLD_JOB: job } });
      const macOk = mac.code === 0;
      checks.push({ name: `Mac → ${nodeHost()} (proxy hop used by Remote-SSH)`, ok: macOk, detail: (mac.stdout || mac.stderr).trim() });
      await cfg().update('nodeSshAvailable', macOk, vscode.ConfigurationTarget.Global);

      const ov = await runRemote(`srun --jobid=${id} --overlap true 2>&1; echo "rc=$?"`).catch(e => errMsg(e));
      const ovOk = /rc=0\s*$/.test(ov);
      checks.push({ name: 'srun --overlap (attach shell to job)', ok: ovOk, detail: ovOk ? 'supported' : ov.trim() });
      await cfg().update('srunOverlap', ovOk, vscode.ConfigurationTarget.Global);
    }
    const misc = await runRemote(
      `lfs quota -q -h -u $USER /work >/dev/null 2>&1 && echo lfs=1 || echo lfs=0; ` +
      `test -d /vault/research/$USER && echo vault=1 || echo vault=0; ` +
      `echo "gres=$(sinfo -h -p gpu1v100 -o %G 2>/dev/null | head -n1)"`);
    const kv = Object.fromEntries(misc.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    checks.push({ name: 'lfs quota for users', ok: kv.lfs === '1', detail: kv.lfs === '1' ? 'works' : 'unavailable → df fallback' });
    checks.push({ name: 'Vault directory', ok: kv.vault === '1', detail: `/vault/research/${utsaId()}` });
    checks.push({ name: 'GPU GRES reported by sinfo (gpu1v100)', ok: undefined, detail: `${kv.gres || '(none)'} — used verbatim for --gres` });
  } catch (e) {
    if (e instanceof NotSignedIn) throw e;
    checks.push({ name: 'Verification', ok: false, detail: errMsg(e) });
  } finally {
    if (id) await runRemote(`scancel ${id}`).catch(() => undefined);
  }

  const mark = (c: Check) => (c.ok === undefined ? 'ℹ' : c.ok ? '✅' : '❌');
  const report = checks.map(c => `${mark(c)}  ${c.name}\n     ${c.detail}`).join('\n\n');
  const nodeOk = checks.find(c => c.name.startsWith('Mac →'))?.ok;
  const advice = nodeOk === false
    ? '\n\nCompute-node SSH is not available: "Open on Node" is disabled. Work in the login window and use\n' +
      '"Attach Shell to Job" (srun --jobid … --pty) to run things on the node, or ask RCSG about node access.'
    : '';
  const doc = await vscode.workspace.openTextDocument({ content: `Arc verification — ${new Date().toLocaleString()}\n\n${report}${advice}\n` });
  await vscode.window.showTextDocument(doc, { preview: true });
  log(report);
  const passed = checks.every(c => c.ok !== false);
  if (checks.some(c => c.name.startsWith('Mac →'))) await ctx.globalState.update(S.verified, utsaId());
  await refreshSetupContext();
  return passed;
}

// ─────────────── 7. Workspace ───────────────

export const workspacePath = () => `/home/${utsaId()}/.arc/arc.code-workspace`;

export async function openWorkspace(onNode = false) {
  if (!utsaId()) throw new Error('Run setup first.');
  const host = onNode ? nodeHost() : loginHost();
  await vscode.commands.executeCommand('vscode.openFolder',
    vscode.Uri.parse(`vscode-remote://ssh-remote+${host}${workspacePath()}`), { forceNewWindow: !onArc() || onNode });
}

export async function reviewWorkspaceSettings(silentIfCurrent = false): Promise<void> {
  const id = utsaId();
  if (!id || !onArc()) { if (!silentIfCurrent) vscode.window.showWarningMessage('Open an Arc workspace (login or node window) first.'); return; }
  if (!vscode.workspace.workspaceFolders?.length) { if (!silentIfCurrent) vscode.window.showWarningMessage('No workspace is open.'); return; }
  const tmpl = workspaceSettings(id);
  const baseline = vscode.workspace.getConfiguration().inspect<Baseline>('arc.appliedTemplate')?.workspaceValue;
  if (silentIfCurrent && baseline && baseline.version >= WS_TEMPLATE_VERSION) return;
  await reviewAndApply('Arc: Workspace settings', tmpl, baseline, vscode.ConfigurationTarget.Workspace,
    b => vscode.workspace.getConfiguration().update('arc.appliedTemplate', b, vscode.ConfigurationTarget.Workspace),
    WS_TEMPLATE_VERSION);
}

/** Non-modal nudge when an Arc workspace predates the current template. Never applies anything by itself. */
export async function maybePromptWorkspaceReview() {
  if (!onArc() || !vscode.workspace.workspaceFolders?.length || !utsaId()) return;
  const b = vscode.workspace.getConfiguration().inspect<Baseline>('arc.appliedTemplate')?.workspaceValue;
  if (b && b.version >= WS_TEMPLATE_VERSION) return;
  const dismissKey = `arc.dismissedTemplate.${WS_TEMPLATE_VERSION}`;
  if (ctx.workspaceState.get(dismissKey)) return;
  const changes = planMerge(workspaceSettings(utsaId()), b, vscode.ConfigurationTarget.Workspace);
  if (!changes.length) {
    await vscode.workspace.getConfiguration().update('arc.appliedTemplate',
      { version: WS_TEMPLATE_VERSION, values: workspaceSettings(utsaId()) }, vscode.ConfigurationTarget.Workspace);
    return;
  }
  const a = await vscode.window.showInformationMessage(
    `Arc: ${changes.length} recommended workspace setting change(s) available. Nothing changes until you review.`,
    'Review', 'Not for this workspace');
  if (a === 'Review') await reviewWorkspaceSettings();
  if (a === 'Not for this workspace') await ctx.workspaceState.update(dismissKey, true);
}

// ─────────────── run everything ───────────────

export async function runFullSetup() {
  const steps: [string, () => Promise<boolean>][] = [
    ['Configure SSH', configureSsh],
    ['User settings', applyUserSettings],
    ['Sign in (DUO)', signIn],
    ['SSH key', setupKey],
    ['Prepare Arc', prepareRemote],
    ['Verify', verify],
  ];
  for (const [name, fn] of steps) {
    try {
      if (!(await fn())) {
        const a = await vscode.window.showWarningMessage(`Arc setup: "${name}" did not complete.`, 'Continue anyway', 'Stop');
        if (a !== 'Continue anyway') return;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Arc setup — ${name}: ${errMsg(e)}`);
      return;
    }
  }
  const a = await vscode.window.showInformationMessage('Arc setup complete.', 'Open Arc workspace (login node)');
  if (a) await openWorkspace(false);
}
