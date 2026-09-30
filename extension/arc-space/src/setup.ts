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
import { diagnoseHop, HopResult, nodeEnvScript, parseNodeEnv, NodeEnv } from './diagnose';

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
  writeFileAtomic(expandHome(PROXY_SCRIPT), proxyScript(loginHost(), holdName(), cfg().get<'forward' | 'relay'>('proxyMode', 'forward')), 0o700);
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
  const vaultPath = (vscode.workspace.getConfiguration('arc').get<{ label: string; path: string }[]>('storage', [])
    .find(d => d.label === 'vault')?.path ?? '').replace(/\$\{user\}/g, id);
  if (kv.vault !== '1' && vaultPath && !vaultPath.endsWith(`/${id}`)) {
    kv.vault = (await runRemote(`test -d ${q(vaultPath)} && echo 1 || echo 0`)).trim();
  }
  if (kv.ws === '1') {
    notes.push('~/.arc/arc.code-workspace already exists — left untouched (use "Arc: Review Workspace Settings" inside it).');
  } else {
    await runRemote('cat > ~/.arc/arc.code-workspace', { stdin: workspaceFile(id, kv.vault === '1', vaultPath || undefined) });
    notes.push('Created ~/.arc/arc.code-workspace.');
  }
  if (kv.vault !== '1') notes.push('⚠ No vault folder found — omitted from the workspace. Run "Arc: Find Vault Folder".');
  if (kv.lfs !== '1') notes.push('⚠ lfs not on PATH — storage view falls back to df.');
  await ctx.globalState.update(S.remotePrepared, id);
  vscode.window.showInformationMessage(`Arc prepared. ${notes.join(' ')}`);
  await refreshSetupContext();
  return true;
}

// ─────────────── 6. Verify ───────────────

interface Check { name: string; ok: boolean | undefined; detail: string; }

/** Apply the remedy a hop diagnosis suggests. Returns true if it's worth re-testing. */
async function remedy(h: HopResult): Promise<boolean> {
  const key = ctx.globalState.get<string>(S.keyPath) ?? '~/.ssh/id_ed25519_arc';
  switch (h.fix) {
    case 'relay':
      await cfg().update('proxyMode', 'relay', vscode.ConfigurationTarget.Global);
      writeManagedSshFiles();
      return true;
    case 'agent': {
      const a = await vscode.window.showInformationMessage(
        `Your key is accepted by ${h.node} but needs its passphrase. Load it into the macOS keychain/agent once so VS Code can use it without prompts?`,
        'Load key', 'Skip');
      if (a !== 'Load key') return false;
      await localTerminal('Arc: ssh-add', `ssh-add --apple-use-keychain ${key} || ssh-add ${key}`);
      return !!(await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
        title: 'Arc: enter the key passphrase in the terminal…' },
        (_p, t) => waitFor(async () => (await spawnP('ssh-add', ['-l'], { timeoutMs: 4000 })).stdout.includes('arc-slurm') ||
          (await spawnP('ssh-add', ['-T', expandHome(key) + '.pub'], { timeoutMs: 4000 })).code === 0, 120_000, t)));
    }
    case 'rewriteProxy':
      writeManagedSshFiles();
      vscode.window.showInformationMessage('Arc: proxy script rewritten from this version.');
      return true;
    case 'installKey':
    case 'keyMissing': {
      const a = await vscode.window.showInformationMessage('Set up (or re-install) your SSH key for Arc now?', 'Set up key', 'Skip');
      return a === 'Set up key' ? setupKey() : false;
    }
    default: return false;
  }
}

async function findVaultCandidates(): Promise<{ defaultOk: boolean; mounted: boolean; candidates: string[] }> {
  const out = await runRemote(
    `test -d /vault/research/$USER && echo "default=1" || echo "default=0"; ` +
    `test -d /vault/research && echo "mounted=1" || echo "mounted=0"; ` +
    `for d in /vault/$USER /vault/research/$USER; do test -d "$d" && echo "cand=$d"; done; ` +
    `find /vault/research -mindepth 1 -maxdepth 1 -type d \\( -user "$USER" -o -writable \\) 2>/dev/null | head -n 20 | sed 's/^/cand=/'`,
    { timeoutMs: 30_000 }).catch(() => '');
  const lines = out.trim().split('\n');
  return {
    defaultOk: lines.includes('default=1'),
    mounted: lines.includes('mounted=1'),
    candidates: [...new Set(lines.filter(l => l.startsWith('cand=')).map(l => l.slice(5)))],
  };
}

export async function setVaultPath(p: string) {
  const conf = vscode.workspace.getConfiguration('arc');
  const cur = conf.inspect<{ label: string; path: string }[]>('storage');
  const list = (cur?.globalValue ?? cur?.defaultValue ?? []).map(d => (d.label === 'vault' ? { ...d, path: p } : d));
  if (!list.some(d => d.label === 'vault')) list.push({ label: 'vault', path: p });
  await conf.update('storage', list, vscode.ConfigurationTarget.Global);
}

export async function findVault(interactive = true): Promise<Check> {
  const v = await findVaultCandidates();
  if (v.defaultOk) return { name: 'Vault directory', ok: true, detail: `/vault/research/${utsaId()}` };
  if (!v.mounted) return { name: 'Vault directory', ok: false, detail: '/vault/research is not mounted on the login node.' };
  if (!v.candidates.length) {
    return { name: 'Vault directory', ok: false, detail:
      `No folder under /vault/research is owned by or writable for you. Your vault may not be provisioned yet; ` +
      `request it at https://support.utsa.edu/myportal, then run "Arc: Find Vault Folder".` };
  }
  let chosen: string | undefined = v.candidates.length === 1 ? v.candidates[0] : undefined;
  if (interactive) {
    const pick = await vscode.window.showQuickPick(v.candidates.map(c => ({ label: c })),
      { title: 'Arc: which folder is your vault?', placeHolder: 'Folders under /vault/research you own or can write to', ignoreFocusOut: true });
    chosen = pick?.label;
  }
  if (!chosen) return { name: 'Vault directory', ok: undefined, detail: `Found ${v.candidates.join(', ')} — run "Arc: Find Vault Folder" to choose.` };
  await setVaultPath(chosen);
  return { name: 'Vault directory', ok: true, detail: `${chosen} (saved to arc.storage; add it to the workspace from Storage → vault → +)` };
}

function hopChecks(h: HopResult, loginToNodeOk: boolean): Check[] {
  const c: Check[] = [];
  if (h.stage === 'resolve') { c.push({ name: 'Proxy finds the job\'s node', ok: false, detail: `${h.cause}\n     ${h.log}` }); return c; }
  c.push({ name: 'Proxy finds the job\'s node', ok: true, detail: h.node ?? '' });
  c.push({ name: 'Login node relays a stream to the node',
    ok: h.forwardOk || h.relayOk ? true : false,
    detail: h.forwardOk ? 'ssh -W forwarding works' : h.relayOk ? 'forwarding (-W) is blocked; the bash relay works' : h.cause });
  if (h.stage === 'forward' && !h.relayOk) return c;
  c.push({ name: `Node accepts this Mac's key (${nodeHost()} → ${h.node})`, ok: h.ok,
    detail: h.ok ? 'authenticated' : `${h.cause}${h.log ? '\n     ' + h.log.replace(/\n/g, '\n     ') : ''}` });
  if (!h.ok && loginToNodeOk && h.structural)
    c.push({ name: 'Conclusion', ok: false, detail: 'Arc lets you SSH between its own nodes, but not from your Mac to a node. VS Code windows on nodes are not possible; use the login window + "Attach Shell to Job".' });
  return c;
}

export async function verify(): Promise<boolean> {
  if (!(await ensureSignedIn())) return false;
  const checks: Check[] = [];
  const job = 'arc-verify';
  let id = '';
  let hop: HopResult | undefined;
  try {
    const parts = await getPartitions();
    const p = ['compute1', 'compute2', 'compute3'].map(n => parts.find(x => x.name === n)).find(x => x && (x.states.get('idle') ?? 0) > 0)
      ?? parts.find(x => x.name === 'compute1') ?? parts[0];
    id = (await runRemote(`sbatch --parsable -J ${job} -p ${q(p.name)} -t 00:10:00 -N 1 -n 1 -c 1 -o /dev/null --wrap 'sleep 600'`)).trim().split(';')[0];

    const node = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
      title: `Arc: verifying — waiting for a short test job on ${p.name} (${id})…` }, async (_pr, tok) => {
      let n = '';
      await waitFor(async () => {
        const [st, nl] = (await runRemote(`squeue -h -j ${id} -o '%T|%N'`)).trim().split('|');
        if (st === 'RUNNING') { n = nl; return true; }
        return !st;
      }, 240_000, tok, 4000);
      return n;
    });
    if (!node) {
      checks.push({ name: 'Test job started', ok: false, detail: 'Did not reach RUNNING within 4 min (queue busy?). Re-run later.' });
    } else {
      checks.push({ name: 'Test job started', ok: true, detail: `${id} on ${node}` });
      const fromLogin = await runRemote(`ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${node} hostname 2>&1; echo "rc=$?"`).catch(e => errMsg(e));
      const loginOk = /rc=0\s*$/.test(fromLogin);
      checks.push({ name: 'Login node → compute node SSH (inside Arc)', ok: loginOk, detail: fromLogin.trim().replace(/\n/g, ' ') });

      // Mac → node, link by link, with up to two automatic remedies.
      const key = ctx.globalState.get<string>(S.keyPath);
      hop = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Arc: testing the Mac → node hop…' },
        () => diagnoseHop(job, key));
      for (let i = 0; i < 2 && !hop.ok && !hop.structural && hop.fix && hop.fix !== 'none'; i++) {
        if (!(await remedy(hop))) break;
        hop = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Arc: re-testing the Mac → node hop…' },
          () => diagnoseHop(job, ctx.globalState.get<string>(S.keyPath)));
      }
      checks.push(...hopChecks(hop, loginOk));
      // Only a structural failure disables "Open on node"; a passphrase that Remote-SSH can prompt for does not.
      const usable = hop.ok || (!hop.structural && hop.fix === 'agent');
      await cfg().update('nodeSshAvailable', usable ? true : hop.structural ? false : null, vscode.ConfigurationTarget.Global);

      const ov = await runRemote(`srun --jobid=${id} --overlap true 2>&1; echo "rc=$?"`).catch(e => errMsg(e));
      const ovOk = /rc=0\s*$/.test(ov);
      checks.push({ name: 'srun --overlap (attach shell / job monitor)', ok: ovOk, detail: ovOk ? 'supported' : ov.trim() });
      await cfg().update('srunOverlap', ovOk, vscode.ConfigurationTarget.Global);
    }
    const misc = await runRemote(
      `lfs quota -q -h -u $USER /work >/dev/null 2>&1 && echo lfs=1 || echo lfs=0; ` +
      `echo "gres=$(sinfo -h -p gpu1v100 -o %G 2>/dev/null | head -n1)"`);
    const kv = Object.fromEntries(misc.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    checks.push({ name: 'lfs quota for users', ok: kv.lfs === '1', detail: kv.lfs === '1' ? 'works' : 'unavailable → df fallback' });
    checks.push(await findVault(true));
    checks.push({ name: 'GPU GRES reported by sinfo (gpu1v100)', ok: undefined, detail: `${kv.gres || '(none)'} — used verbatim for --gres` });
  } catch (e) {
    if (e instanceof NotSignedIn) throw e;
    checks.push({ name: 'Verification', ok: false, detail: errMsg(e) });
  } finally {
    if (id) await runRemote(`scancel ${id}`).catch(() => undefined);
  }

  const mark = (c: Check) => (c.ok === undefined ? 'ℹ' : c.ok ? '✅' : '❌');
  const report = checks.map(c => `${mark(c)}  ${c.name}\n     ${c.detail}`).join('\n\n');
  let advice = '';
  if (hop && !hop.ok) {
    advice = hop.structural
      ? '\n\n"Open on node" is disabled. Work in the login window; use "Attach Shell to Job" and the Job Monitor to run and watch work on nodes.'
      : hop.fix === 'agent'
        ? '\n\n"Open on node" stays enabled: Remote-SSH will ask for your key passphrase when it connects. Load the key into the agent to skip that prompt.'
        : '\n\nFix the item above, then run "Arc: Diagnose Node Connection" (no need to redo the whole verification).';
  }
  advice += '\n\nIf Remote-SSH reaches the node but fails with "Got bad result from install script", run "Arc: Check Node for VS Code Server".';
  if (cfg().get('proxyMode') === 'relay') advice += '\n\nNote: the proxy now uses the bash relay because the login node blocks SSH forwarding.';
  const doc = await vscode.workspace.openTextDocument({ content: `Arc verification — ${new Date().toLocaleString()}\n\n${report}${advice}\n` });
  await vscode.window.showTextDocument(doc, { preview: true });
  log(report);
  await ctx.globalState.update(S.verified, utsaId());
  await refreshSetupContext();
  return checks.every(c => c.ok !== false);
}

/** Re-test only the Mac → node hop against your running holder job (or a short test job). */
export async function diagnoseNode() {
  if (!(await ensureSignedIn())) return;
  const holder = (await runRemote(`squeue -u $USER --name=${holdName()} --states=RUNNING -h -o %i`)).trim();
  let job = holdName(), testId = '';
  if (!holder) {
    const a = await vscode.window.showInformationMessage('No running holder job. Start a 10-minute test job to diagnose against?', 'Start test job');
    if (!a) return;
    job = 'arc-verify';
    testId = (await runRemote(`sbatch --parsable -J ${job} -p compute1 -t 00:10:00 -N 1 -n 1 -c 1 -o /dev/null --wrap 'sleep 600'`)).trim().split(';')[0];
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true, title: `Arc: waiting for test job ${testId}…` },
      (_p, t) => waitFor(async () => (await runRemote(`squeue -h -j ${testId} -o %T`)).trim() === 'RUNNING', 240_000, t, 4000));
    if (!ok) { await runRemote(`scancel ${testId}`).catch(() => undefined); vscode.window.showWarningMessage('Test job did not start in time.'); return; }
  }
  try {
    let hop = await diagnoseHop(job, ctx.globalState.get<string>(S.keyPath));
    for (let i = 0; i < 2 && !hop.ok && !hop.structural && hop.fix && hop.fix !== 'none'; i++) {
      if (!(await remedy(hop))) break;
      hop = await diagnoseHop(job, ctx.globalState.get<string>(S.keyPath));
    }
    const usable = hop.ok || (!hop.structural && hop.fix === 'agent');
    await cfg().update('nodeSshAvailable', usable ? true : hop.structural ? false : null, vscode.ConfigurationTarget.Global);
    const checks = hopChecks(hop, true);
    const text = checks.map(c => `${c.ok === undefined ? 'ℹ' : c.ok ? '✅' : '❌'}  ${c.name}\n     ${c.detail}`).join('\n\n');
    const doc = await vscode.workspace.openTextDocument({ content: `Arc node connection — ${new Date().toLocaleString()}\n\n${text}\n` });
    await vscode.window.showTextDocument(doc, { preview: true });
  } finally {
    if (testId) await runRemote(`scancel ${testId}`).catch(() => undefined);
  }
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


// ─────────────── VS Code server prerequisites on compute nodes ───────────────

/** Runs fn with the node of your running holder job, or a short test job it starts and cancels. */
async function withNode<T>(fn: (node: string) => Thenable<T> | Promise<T>): Promise<T | undefined> {
  const held = (await runRemote(`squeue -u $USER --name=${holdName()} --states=RUNNING -h -o %N`)).trim();
  if (held && !held.includes('[')) return fn(held);
  const a = await vscode.window.showInformationMessage('No running holder job. Start a 10-minute test job to check a node?', 'Start test job');
  if (!a) return undefined;
  const id = (await runRemote(`sbatch --parsable -J arc-verify -p compute1 -t 00:10:00 -N 1 -n 1 -c 1 -o /dev/null --wrap 'sleep 600'`)).trim().split(';')[0];
  try {
    let node = '';
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true, title: `Arc: waiting for test job ${id}…` },
      (_p, t) => waitFor(async () => { const [st, n] = (await runRemote(`squeue -h -j ${id} -o '%T|%N'`)).trim().split('|'); node = n; return st === 'RUNNING'; }, 240_000, t, 4000));
    return ok ? await fn(node) : undefined;
  } finally { await runRemote(`scancel ${id}`).catch(() => undefined); }
}

export async function checkNodeEnv() {
  if (!(await ensureSignedIn())) return;
  const env = await withNode<NodeEnv>(node => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
    title: `Arc: checking VS Code server prerequisites on ${node}…` },
    async () => parseNodeEnv(node, await runRemote(nodeEnvScript(node), { timeoutMs: 90_000 }), utsaId(), nodeHost())));
  if (!env) return;
  const mark = (ok: boolean | undefined) => (ok === undefined ? 'ℹ' : ok ? '✅' : '❌');
  const body = env.findings.map(x => `${mark(x.ok)}  ${x.name}\n     ${x.detail}`).join('\n\n') +
    (env.notes.length ? `\n\nWhat to do\n${env.notes.map(n => `  • ${n}`).join('\n')}` : '') +
    `\n\nProposed Remote-SSH settings (you review each one next):\n${JSON.stringify(env.settings, null, 2)}\n`;
  const doc = await vscode.workspace.openTextDocument({ content: `Arc node environment — ${env.node} — ${new Date().toLocaleString()}\n\n${body}` });
  await vscode.window.showTextDocument(doc, { preview: true });
  const n = await reviewAndApply('Arc: Remote-SSH settings for compute nodes', env.settings,
    ctx.globalState.get<Baseline>('arc.nodeEnvBaseline'), vscode.ConfigurationTarget.Global,
    b => ctx.globalState.update('arc.nodeEnvBaseline', b), 1);
  if (n) {
    const a = await vscode.window.showInformationMessage(
      env.noise ? 'Settings applied. Fix the shell start-up output first (see the report), then open the workspace on the node.'
                : 'Settings applied. Open the workspace on your node now?', ...(env.noise ? [] : ['Open on node']));
    if (a === 'Open on node') await vscode.commands.executeCommand('arc.connectNode');
  }
}
