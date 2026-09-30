/*
 * Transport: the extension runs on your Mac (extensionKind "ui") and reaches Arc
 * with `ssh <loginHost> …`. ControlMaster multiplexes every call over the one
 * DUO-authenticated socket, and BatchMode guarantees a call can never hang on
 * an interactive prompt. When the socket is gone, calls fail fast with NotSignedIn.
 */
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as os from 'os';

export const cfg = () => vscode.workspace.getConfiguration('arc');
export const loginHost = () => cfg().get<string>('sshLoginHost', 'arc');
export const nodeHost = () => cfg().get<string>('sshNodeHost', 'arc-node');
export const utsaId = () => cfg().get<string>('utsaId', '').trim();
export const holdName = () => cfg().get<string>('holdJobName', 'vscode');
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class NotSignedIn extends Error {
  constructor() { super('Not signed in to Arc (no SSH master connection). Run "Arc: Sign In (DUO)".'); }
}
export class NotConfigured extends Error {
  constructor() { super('Arc is not set up yet. Run "Arc: Run Setup" or open the Arc walkthrough.'); }
}

let out: vscode.OutputChannel;
export function initTransport(channel: vscode.OutputChannel) { out = channel; }
export const log = (s: string) => out?.appendLine(s);

export interface SpawnResult { code: number; stdout: string; stderr: string; }
export function spawnP(cmd: string, args: string[], o: { stdin?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<SpawnResult> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: { ...process.env, ...o.env } });
    let stdout = '', stderr = '', done = false;
    const finish = (code: number) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += `\n(timed out after ${o.timeoutMs} ms)`; finish(124); }, o.timeoutMs ?? 30_000);
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', e => { stderr += e.message; finish(127); });
    child.on('close', c => finish(c ?? 1));
    if (o.stdin !== undefined) child.stdin.end(o.stdin); else child.stdin.end();
  });
}

export async function isSignedIn(): Promise<boolean> {
  if (!utsaId()) return false;
  return (await spawnP('ssh', ['-O', 'check', loginHost()], { timeoutMs: 5000 })).code === 0;
}

/** Run a bash script on the login node over the multiplexed connection. */
export async function runRemote(script: string, o: { stdin?: string; timeoutMs?: number } = {}): Promise<string> {
  if (!utsaId()) throw new NotConfigured();
  log(`[arc] ${script.length > 300 ? script.slice(0, 300) + '…' : script}`);
  const r = await spawnP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', loginHost(), 'bash', '-c', q(script)], o);
  if (r.code === 255) { log(`  ! ${r.stderr.trim()}`); throw new NotSignedIn(); }
  if (r.code !== 0) { const m = r.stderr.trim() || `exit ${r.code}`; log(`  ! ${m}`); throw new Error(m); }
  return r.stdout;
}
/** Run one remote command with safely quoted arguments. */
export const rr = (cmd: string, args: string[], o?: { stdin?: string; timeoutMs?: number }) =>
  runRemote([cmd, ...args.map(q)].join(' '), o);

// ─────────────── which host is this window attached to? ───────────────

export type WindowHost = 'local' | 'login' | 'node' | 'other';

function sshAuthorityHost(authority: string): string | undefined {
  if (!authority.startsWith('ssh-remote+')) return undefined;
  const raw = decodeURIComponent(authority.slice('ssh-remote+'.length));
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {       // Remote-SSH hex-encoded JSON form
    try { return JSON.parse(Buffer.from(raw, 'hex').toString('utf8')).hostName; } catch { /* plain alias */ }
  }
  return raw.replace(/^[^@]*@/, '');
}

export function windowAuthority(): string | undefined {
  return (vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.authority || undefined;
}

export function windowHost(): WindowHost {
  if (!vscode.env.remoteName) return 'local';
  if (vscode.env.remoteName !== 'ssh-remote') return 'other';
  const a = windowAuthority();
  if (!a) return 'login';                                   // empty remote window; Arc is by far the likeliest
  const h = sshAuthorityHost(a);
  if (h === loginHost() || h === 'arc.utsa.edu') return 'login';
  if (h === nodeHost()) return 'node';
  return 'other';
}
export const onArc = () => { const w = windowHost(); return w === 'login' || w === 'node'; };

/** URI for an absolute Arc path in this window, or undefined when the window isn't on Arc. */
export function arcUri(path: string): vscode.Uri | undefined {
  const a = windowAuthority();
  return onArc() && a ? vscode.Uri.from({ scheme: 'vscode-remote', authority: a, path }) : undefined;
}

/**
 * Command line that runs `script` on Arc from this window's integrated terminal:
 * directly when the window is already on Arc, via `ssh -t` from a local window.
 */
export function shellFor(script: string): string {
  const inner = `bash -lc ${q(script)}`;
  const w = windowHost();
  if (w === 'login' || w === 'node') return inner;
  if (w === 'local') return `ssh -t ${loginHost()} ${q(inner)}`;
  throw new Error('This window is connected to a non-Arc remote; open a local or Arc window.');
}

export function arcTerminal(name: string, script: string) {
  const t = vscode.window.createTerminal({ name });
  t.show();
  t.sendText(shellFor(script));
  return t;
}

/** A terminal on THIS Mac, even from a remote window (needed for DUO sign-in and ssh-keygen). */
export async function localTerminal(name: string, command: string): Promise<vscode.Terminal> {
  let t: vscode.Terminal | undefined;
  if (!vscode.env.remoteName) {
    t = vscode.window.createTerminal({ name });
  } else {
    const opened = new Promise<vscode.Terminal>(res => {
      const d = vscode.window.onDidOpenTerminal(x => { d.dispose(); res(x); });
    });
    await vscode.commands.executeCommand('workbench.action.terminal.newLocal');
    t = await Promise.race([opened, sleep(8000).then(() => undefined)]);
    if (!t) throw new Error('Could not open a local terminal.');
  }
  t.show();
  t.sendText(command);
  return t;
}

export async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, token?: vscode.CancellationToken, everyMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !token?.isCancellationRequested) {
    if (await pred()) return true;
    await sleep(everyMs);
  }
  return false;
}
