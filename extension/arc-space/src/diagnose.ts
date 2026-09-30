/*
 * Diagnose the Mac → compute-node hop one link at a time, so a failure says WHICH link broke:
 *
 *   1. resolve  — can the proxy find the node running the job?          (ssh arc squeue …)
 *   2. forward  — can the login node relay a TCP stream to node:22?      (ssh -W, else bash /dev/tcp relay)
 *   3. auth     — does the node's sshd accept this Mac's key?            (ssh -v arc-node true)
 */
import * as fs from 'fs';
import { spawn } from 'child_process';
import { loginHost, nodeHost, spawnP, expandHome, cfg } from './transport';

export type Fix = 'relay' | 'agent' | 'installKey' | 'keyMissing' | 'rewriteProxy' | 'none';
export interface HopResult {
  ok: boolean;
  stage: 'resolve' | 'forward' | 'auth' | 'done';
  node?: string;
  cause: string;          // one sentence: what is wrong
  fix?: Fix;
  structural: boolean;    // true → no client-side fix; VS Code cannot open on nodes
  forwardOk?: boolean; relayOk?: boolean; methods?: string[];
  log: string;            // trimmed evidence for the report
}

/** Open a byte stream and wait for the node's SSH banner. */
function bannerVia(args: string[], timeoutMs = 12_000): Promise<{ ok: boolean; err: string }> {
  return new Promise(resolve => {
    const child = spawn('ssh', args);
    let out = '', err = '', done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(t); child.kill('SIGTERM'); resolve({ ok, err: err.trim() }); };
    const t = setTimeout(() => finish(false), timeoutMs);
    child.stdout.on('data', d => { out += d; if (/^SSH-\d/m.test(out)) finish(true); });
    child.stderr.on('data', d => (err += d));
    child.on('close', () => finish(/^SSH-\d/m.test(out)));
    child.on('error', e => { err += e.message; finish(false); });
  });
}

export function proxyLogTail(n = 8): string {
  try { return fs.readFileSync(expandHome('~/.ssh/arc-slurm-proxy.log'), 'utf8').trim().split('\n').slice(-n).map(l => `proxy log: ${l}`).join('\n'); }
  catch { return ''; }
}

/** Run the installed proxy the way ssh does: client banner on stdin first, expect the node's banner on stdout. */
function proxyBanner(script: string, jobName: string, timeoutMs = 15_000): Promise<{ ok: boolean; err: string }> {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', [script], { env: { ...process.env, ARC_HOLD_JOB: jobName } });
    let out = '', err = '', done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(t); child.kill('SIGTERM'); resolve({ ok, err: err.trim() }); };
    const t = setTimeout(() => finish(false), timeoutMs);
    child.stdout.on('data', d => { out += d; if (/^SSH-\d/m.test(out)) finish(true); });
    child.stderr.on('data', d => (err += d));
    child.on('close', () => finish(/^SSH-\d/m.test(out)));
    child.stdin.write('SSH-2.0-arc-diagnose\r\n');      // real clients speak first; the proxy must not swallow this
  });
}

export const relayCommand = (node: string) => `bash -c 'exec 3<>/dev/tcp/${node}/22; cat <&3 & exec cat >&3'`;

const interesting = (l: string) =>
  /Too many authentication failures|pam_slurm_adopt|Access denied|Received disconnect|Authentications that can continue|Offering public key|Server accepts key|Permission denied|no such identity|agent refused|sign_and_send_pubkey|passphrase|Authenticated to|Connection closed|kex_exchange|administratively prohibited|channel .* open failed|arc:|Could not resolve|timed out|Load key|invalid format/i.test(l);

export async function diagnoseHop(jobName: string, keyPath?: string): Promise<HopResult> {
  const login = loginHost();

  // 1. resolve
  const r = await spawnP('ssh', ['-o', 'BatchMode=yes', login,
    `squeue -u "$USER" --name=${jobName} --states=RUNNING --noheader --format=%N`], { timeoutMs: 20_000 });
  const node = r.stdout.trim().split('\n')[0]?.trim();
  if (r.code !== 0 || !node) {
    return { ok: false, stage: 'resolve', structural: false,
      cause: r.code === 255 ? 'The login connection is not available (signed out?).' : `No RUNNING job named "${jobName}" was found.`,
      log: (r.stderr || r.stdout).trim() };
  }
  if (node.includes('[')) {
    return { ok: false, stage: 'resolve', node, structural: false, cause: `The job spans several nodes (${node}); the proxy needs a 1-node job.`, log: '' };
  }

  // 2. forward (-W through the multiplexed login connection), then the relay fallback
  const fw = await bannerVia(['-o', 'BatchMode=yes', '-W', `${node}:22`, login]);
  let relayOk: boolean | undefined;
  if (!fw.ok) relayOk = (await bannerVia(['-o', 'BatchMode=yes', login, relayCommand(node)])).ok;
  if (!fw.ok && !relayOk) {
    return { ok: false, stage: 'forward', node, structural: true, forwardOk: false, relayOk: false,
      cause: `The login node could not open a connection to ${node}:22 by forwarding or by relay.`,
      log: fw.err.split('\n').filter(interesting).slice(-8).join('\n') || fw.err.slice(-600) };
  }
  const mode = cfg().get<string>('proxyMode', 'forward');
  if (!fw.ok && mode !== 'relay') {
    return { ok: false, stage: 'forward', node, structural: false, forwardOk: false, relayOk: true, fix: 'relay',
      cause: /administratively prohibited/i.test(fw.err)
        ? 'The login node prohibits SSH port forwarding (-W), but a shell relay to the node works.'
        : 'SSH forwarding (-W) through the login node failed, but a shell relay to the node works.',
      log: fw.err.split('\n').filter(interesting).slice(-6).join('\n') };
  }

  // 2b. the deployed proxy script itself (what Remote-SSH actually runs), with the client speaking first
  const script = expandHome('~/.ssh/arc-slurm-proxy.sh');
  if (!fs.existsSync(script)) {
    return { ok: false, stage: 'forward', node, structural: false, fix: 'none', forwardOk: fw.ok, relayOk,
      cause: `${script} is missing — run "Arc: Configure SSH".`, log: '' };
  }
  const deployed = await proxyBanner(script, jobName);
  if (!deployed.ok) {
    return { ok: false, stage: 'forward', node, structural: false, fix: 'rewriteProxy', forwardOk: fw.ok, relayOk,
      cause: 'The login node can reach the node, but the installed proxy script does not deliver a working stream. Rewriting it from this version usually fixes this.',
      log: [deployed.err, proxyLogTail()].filter(Boolean).join('\n') };
  }

  // 3. auth — the real Remote-SSH path, verbosely (command-line LogLevel beats the config's LogLevel ERROR)
  const a = await spawnP('ssh', ['-v', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', nodeHost(), 'true'],
    { timeoutMs: 45_000, env: { ARC_HOLD_JOB: jobName } });
  const lines = a.stderr.split('\n');
  const picked = lines.filter(interesting);
  // Never hand back an empty log: fall back to the raw tail.
  const log = (picked.length ? picked : lines.filter(l => l.trim() && !/^debug[23]:/.test(l))).slice(-14).join('\n');
  if (a.code === 0) return { ok: true, stage: 'done', node, structural: false, forwardOk: fw.ok, relayOk, cause: 'OK', log };

  const methods = /Authentications that can continue: ([\w,@.-]+)/i.exec(a.stderr)?.[1].split(',') ?? [];
  const plog = proxyLogTail(6);
  const base = { ok: false as const, stage: 'auth' as const, node, forwardOk: fw.ok, relayOk, methods, log: [log, plog].filter(Boolean).join('\n') };

  if (/no such identity/i.test(a.stderr) || (keyPath && !fs.existsSync(expandHome(keyPath))))
    return { ...base, structural: false, fix: 'keyMissing', cause: 'The SSH key named in the managed config does not exist on this Mac.' };
  if (methods.length && !methods.includes('publickey'))
    return { ...base, structural: true, cause: `${node} does not accept public-key logins from outside the cluster (it allows: ${methods.join(', ')}).` };
  if (/Server accepts key/i.test(a.stderr) || /agent refused|sign_and_send_pubkey|passphrase|incorrect passphrase/i.test(a.stderr))
    return { ...base, structural: false, fix: 'agent',
      cause: 'The node accepts your key, but it is passphrase-protected and not loaded in ssh-agent, so a non-interactive check cannot use it. Remote-SSH itself would prompt for the passphrase.' };
  if (/pam_slurm_adopt|Access denied by pam/i.test(a.stderr))
    return { ...base, structural: false, fix: 'none', cause: `${node} refused the login because you have no running job there (pam_slurm_adopt).` };
  if (/Too many authentication failures/i.test(a.stderr))
    return { ...base, structural: false, fix: 'installKey', cause: 'ssh-agent offered too many keys before the right one; the managed config pins one key once the key step has run.' };
  if (/Offering public key/i.test(a.stderr) && /Permission denied/i.test(a.stderr))
    return { ...base, structural: false, fix: 'installKey', cause: 'The node rejected the key this Mac offered; it is probably not in your Arc ~/.ssh/authorized_keys.' };
  if (!/Offering public key/i.test(a.stderr) && /Permission denied/i.test(a.stderr))
    return { ...base, structural: false, fix: 'installKey', cause: 'This Mac offered no SSH key to the node (no key configured or loaded).' };
  return { ...base, structural: false, fix: 'none', cause: `The hop failed for a reason not recognized automatically (exit ${a.code}). See the log below.` };
}


// ───────────────────── VS Code server prerequisites on the node ─────────────────────
export interface EnvFinding { name: string; ok: boolean | undefined; detail: string; }
export interface NodeEnv { node: string; findings: EnvFinding[]; settings: Record<string, unknown>; notes: string[]; noise: string; }

/** Script run on the LOGIN node; it reaches the compute node with the cluster-internal SSH that verification proved works. */
export function nodeEnvScript(node: string): string {
  return `n=${node}
S="ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o LogLevel=ERROR -o ConnectTimeout=10 $n"
echo "noise=$($S true 2>/dev/null | head -c 600 | base64 | tr -d '\\n')"
echo "rcfiles=$($S 'for f in ~/.bashrc ~/.bash_profile ~/.profile; do [ -f "$f" ] && grep -nE "^[^#]*(echo|printf|cat |module (load|list)|conda activate|fortune|figlet|neofetch)" "$f" | head -n 3 | sed "s|^|$f:|"; done' 2>/dev/null | head -n 8 | base64 | tr -d '\\n')"
$S 'bash -s' <<'EOS'
d="$HOME/.vscode-server"; mkdir -p "$d" 2>/dev/null
echo "glibc=$(ldd --version 2>&1 | head -n1 | grep -oE '[0-9]+\\.[0-9]+$')"
echo "os=$( . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
if command -v flock >/dev/null 2>&1; then
  ( flock -n 9 ) 9>"$d/.arc-flock-test" 2>/dev/null && echo flock=1 || echo flock=0
else echo flock=nocmd; fi
rm -f "$d/.arc-flock-test"
echo "tmpfree=$(df -Pk /tmp 2>/dev/null | awk 'NR==2{print $4}')"
echo "homefree=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://update.code.visualstudio.com/api/latest/server-linux-x64/stable 2>/dev/null)
[ -z "$code" ] && code=000; echo "net=$code"
echo "serverdirs=$(ls -d "$d"/cli/servers/Stable-* "$d"/bin/* 2>/dev/null | wc -l)"
echo "livehosts=$(cat "$d"/.arc-host-* 2>/dev/null | tr '\\n' ' ')"
echo "shell=$SHELL"
EOS`;
}

export function parseNodeEnv(node: string, out: string, id: string, nodeAlias: string): NodeEnv {
  const kv: Record<string, string> = {};
  for (const l of out.split('\n')) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  const b64 = (v?: string) => (v ? Buffer.from(v, 'base64').toString('utf8') : '');
  const noise = b64(kv.noise);
  const rc = b64(kv.rcfiles).split('\n').filter(l => /^[^:\s]+:\d+:/.test(l)).join('\n');   // drop banner lines, keep file:line: matches
  const f: EnvFinding[] = [];
  const settings: Record<string, unknown> = {};
  const notes: string[] = [];

  f.push({ name: 'Shell start-up prints nothing', ok: noise.length === 0,
    detail: noise.length === 0 ? 'clean' :
      `A non-interactive login printed ${noise.length} byte(s): ${JSON.stringify(noise.slice(0, 160))}. ` +
      `Any output breaks the install script. ${rc ? `Likely source:\n       ${rc.replace(/\n/g, '\n       ')}` : ''}` });
  if (noise.length) notes.push('Guard output in your shell start-up files so it only runs interactively, e.g. put `[[ $- == *i* ]] || return` near the top of ~/.bashrc, or wrap echo/module lines in `if [[ $- == *i* ]]; then …; fi`.');

  const glibc = parseFloat(kv.glibc || '0');
  f.push({ name: 'glibc ≥ 2.28 (VS Code server requirement)', ok: glibc >= 2.28, detail: `${kv.glibc || 'unknown'} on ${kv.os || 'unknown OS'}` });
  if (glibc && glibc < 2.28) notes.push('This node\'s glibc is too old for current VS Code servers; this cannot be fixed from the client. Use the login window + Attach Shell / Job Monitor.');

  const flockOk = kv.flock === '1';
  f.push({ name: 'flock works in ~/.vscode-server (Lustre)', ok: kv.flock === 'nocmd' ? undefined : flockOk,
    detail: flockOk ? 'supported' : kv.flock === 'nocmd' ? 'flock command missing' : 'not supported on this mount' });
  if (!flockOk) settings['remote.SSH.lockfilesInTmp'] = true;

  const net = kv.net ?? '000';
  const netOk = /^[23]/.test(net);
  f.push({ name: 'Node can download the VS Code server', ok: netOk, detail: netOk ? `HTTP ${net}` : 'no outbound internet from compute nodes' });
  if (!netOk) settings['remote.SSH.localServerDownload'] = 'always';

  f.push({ name: 'Free space: home / /tmp', ok: Number(kv.homefree) > 1_000_000 && Number(kv.tmpfree) > 200_000,
    detail: `${(Number(kv.homefree) / 2 ** 20).toFixed(1)} GiB / ${(Number(kv.tmpfree) / 2 ** 20).toFixed(1)} GiB` });

  // Login and node windows both use ~/.vscode-server on the SAME Lustre home at the same time. Give the node its own tree.
  settings['remote.SSH.serverInstallPath'] = { [nodeAlias]: `/home/${id}/.arc/node-server` };
  f.push({ name: 'Separate server directory for compute nodes', ok: undefined,
    detail: `login and node windows otherwise share ~/.vscode-server on Lustre concurrently; proposing /home/${id}/.arc/node-server for "${nodeAlias}"` });
  if (!netOk) notes.push('Because nodes have no internet, VS Code will download the server on your Mac and copy it over (localServerDownload: always).');

  return { node, findings: f, settings, notes, noise };
}
