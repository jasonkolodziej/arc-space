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

export type Fix = 'relay' | 'agent' | 'installKey' | 'keyMissing' | 'none';
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

export const relayCommand = (node: string) => `bash -c 'exec 3<>/dev/tcp/${node}/22; cat <&3 & exec cat >&3'`;

const interesting = (l: string) =>
  /Authentications that can continue|Offering public key|Server accepts key|Permission denied|no such identity|agent refused|sign_and_send_pubkey|passphrase|Authenticated to|Connection closed|kex_exchange|administratively prohibited|channel .* open failed|arc:|Could not resolve|timed out|Load key|invalid format/i.test(l);

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

  // 3. auth — the real Remote-SSH path, verbosely (command-line LogLevel beats the config's LogLevel ERROR)
  const a = await spawnP('ssh', ['-o', 'BatchMode=yes', '-o', 'LogLevel=VERBOSE', '-o', 'ConnectTimeout=20', nodeHost(), 'true'],
    { timeoutMs: 45_000, env: { ARC_HOLD_JOB: jobName } });
  const lines = a.stderr.split('\n');
  const log = lines.filter(interesting).slice(-14).join('\n');
  if (a.code === 0) return { ok: true, stage: 'done', node, structural: false, forwardOk: fw.ok, relayOk, cause: 'OK', log };

  const methods = /Authentications that can continue: ([\w,@.-]+)/i.exec(a.stderr)?.[1].split(',') ?? [];
  const base = { ok: false as const, stage: 'auth' as const, node, forwardOk: fw.ok, relayOk, methods, log };

  if (/no such identity/i.test(a.stderr) || (keyPath && !fs.existsSync(expandHome(keyPath))))
    return { ...base, structural: false, fix: 'keyMissing', cause: 'The SSH key named in the managed config does not exist on this Mac.' };
  if (methods.length && !methods.includes('publickey'))
    return { ...base, structural: true, cause: `${node} does not accept public-key logins from outside the cluster (it allows: ${methods.join(', ')}).` };
  if (/Server accepts key/i.test(a.stderr) || /agent refused|sign_and_send_pubkey|passphrase|incorrect passphrase/i.test(a.stderr))
    return { ...base, structural: false, fix: 'agent',
      cause: 'The node accepts your key, but it is passphrase-protected and not loaded in ssh-agent, so a non-interactive check cannot use it. Remote-SSH itself would prompt for the passphrase.' };
  if (/Offering public key/i.test(a.stderr) && /Permission denied/i.test(a.stderr))
    return { ...base, structural: false, fix: 'installKey', cause: 'The node rejected the key this Mac offered; it is probably not in your Arc ~/.ssh/authorized_keys.' };
  if (!/Offering public key/i.test(a.stderr) && /Permission denied/i.test(a.stderr))
    return { ...base, structural: false, fix: 'installKey', cause: 'This Mac offered no SSH key to the node (no key configured or loaded).' };
  return { ...base, structural: false, fix: 'none', cause: `The hop failed for a reason not recognized automatically (exit ${a.code}). See the log below.` };
}
