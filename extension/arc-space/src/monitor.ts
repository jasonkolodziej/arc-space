/*
 * Arc Monitor — a btop-style live view of a job's CPU, memory, network, I/O, GPU and processes,
 * plus Slurm accounting and an efficiency report for past jobs.
 *
 * Live data path (first that works):
 *   1. srun --jobid=<id> --overlap        (inside the allocation; no node SSH needed)
 *   2. ssh <node> from the login node      (if node SSH is allowed)
 *   3. accounting only (sstat / sacct)     (always available)
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import { cfg, loginHost, q, rr, errMsg, log, utsaId } from './transport';
import { samplerScript } from './sampler';
import { getJobs, Job } from './slurm';

// ───────────────────── raw sample (from arcmon.sh) ─────────────────────
interface Raw {
  t: number; host: string; ncpu: number; hz?: number; load: number[];
  cpu: [string, number, number, number, number, number, number, number, number][];
  mem: Record<string, number>;
  net: [string, number, number][]; ib: [string, number, number][]; disk: [string, number, number][];
  lustre: [string, number, number][];
  gpu: [number, string, number, number, number, number, number, number, number][];
  procs: [number, number, number, number, number, string][];   // pid, cpu ticks, rss kB, age s, threads, cmd
}

// ───────────────────── derived sample (to the webview) ─────────────────────
export interface Derived {
  host: string; t: number; ncpu: number; load: number[];
  cpu: number; iowait: number; cores: number[];
  mem: { total: number; used: number; cached: number; swapTotal: number; swapUsed: number };
  net: { name: string; rx: number; tx: number }[];     // bytes/s
  ib: { name: string; rx: number; tx: number }[];
  lustre: { name: string; rx: number; tx: number }[];  // read / write bytes/s
  disk: { name: string; rx: number; tx: number }[];
  gpu: { i: number; name: string; util: number; memUtil: number; memUsed: number; memTotal: number; power: number; powerLimit: number; temp: number }[];
  procs: { pid: number; cpu: number; mem: number; rss: number; age: number; threads: number; cmd: string }[];
  procTotals: { count: number; threads: number; rss: number };
}

function cpuBusy(a: Raw['cpu'][number], b: Raw['cpu'][number]) {
  const sum = (r: Raw['cpu'][number]) => r.slice(1).reduce((x: number, y) => x + (y as number), 0);
  const dt = sum(b) - sum(a);
  if (dt <= 0) return { busy: 0, io: 0 };
  const idle = (b[4] + b[5]) - (a[4] + a[5]);
  return { busy: Math.max(0, Math.min(1, 1 - idle / dt)), io: Math.max(0, (b[5] - a[5]) / dt) };
}

function rates(prev: [string, number, number][], cur: [string, number, number][], dt: number) {
  const p = new Map(prev.map(r => [r[0], r]));
  return cur.map(([name, rx, tx]) => {
    const o = p.get(name);
    // Counter resets/wraps → 0 for that interval rather than a giant spike.
    const d = (a: number, b: number) => (o && b >= a ? (b - a) / dt : 0);
    return { name, rx: o ? d(o[1], rx) : 0, tx: o ? d(o[2], tx) : 0 };
  });
}

function procStats(prev: Raw, s: Raw, dt: number, memTotal: number) {
  const hz = s.hz || 100;
  const before = new Map(prev.procs.map(p => [p[0], p[1]]));
  const all = s.procs.map(p => {
    const t0 = before.get(p[0]);
    return { pid: p[0], cpu: t0 !== undefined && p[1] >= t0 ? ((p[1] - t0) / hz / dt) * 100 : 0,
      mem: memTotal ? (p[2] * 1024) / memTotal * 100 : 0, rss: p[2] * 1024, age: p[3], threads: p[4], cmd: p[5] };
  });
  all.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
  return {
    procs: all.slice(0, 40),
    procTotals: { count: all.length, threads: all.reduce((a, p) => a + p.threads, 0), rss: all.reduce((a, p) => a + p.rss, 0) },
  };
}

export function derive(prev: Raw | undefined, s: Raw): Derived | undefined {
  if (!prev) return undefined;
  const dt = Math.max(0.001, s.t - prev.t);
  const pc = new Map(prev.cpu.map(r => [r[0], r]));
  const agg = s.cpu.find(r => r[0] === 'cpu');
  const aggP = pc.get('cpu');
  const total = agg && aggP ? cpuBusy(aggP, agg) : { busy: 0, io: 0 };
  const cores = s.cpu.filter(r => r[0] !== 'cpu').map(r => { const o = pc.get(r[0]); return o ? cpuBusy(o, r).busy : 0; });
  const kb = (k: string) => (s.mem[k] ?? 0) * 1024;
  return {
    host: s.host, t: s.t, ncpu: s.ncpu, load: s.load, cpu: total.busy, iowait: total.io, cores,
    mem: { total: kb('MemTotal'), used: kb('MemTotal') - kb('MemAvailable'), cached: kb('Cached') + kb('Buffers'),
           swapTotal: kb('SwapTotal'), swapUsed: kb('SwapTotal') - kb('SwapFree') },
    net: rates(prev.net, s.net, dt).filter(n => !/^(ifb|docker|veth|virbr|br-)/.test(n.name)),
    ib: rates(prev.ib, s.ib, dt),
    lustre: rates(prev.lustre, s.lustre, dt),
    disk: rates(prev.disk, s.disk, dt),
    gpu: s.gpu.map(g => ({ i: g[0], name: g[1], util: g[2], memUtil: g[3], memUsed: g[4] * 2 ** 20, memTotal: g[5] * 2 ** 20,
      power: g[6], powerLimit: g[7], temp: g[8] })),
    ...procStats(prev, s, dt, kb('MemTotal')),
  };
}

// ───────────────────── Slurm time / size parsing ─────────────────────
export function slurmSeconds(v: string): number | undefined {
  if (!v || /^(UNLIMITED|Partition_Limit|INVALID|NOT_SET)$/i.test(v)) return undefined;
  let days = 0, rest = v;
  const dash = v.indexOf('-');
  if (dash > 0) { days = Number(v.slice(0, dash)); rest = v.slice(dash + 1); }
  const parts = rest.split(':').map(Number);
  if (parts.some(isNaN)) return undefined;
  const [h, m, s] = parts.length === 3 ? parts : parts.length === 2 ? [0, parts[0], parts[1]] : [0, 0, parts[0]];
  return days * 86400 + h * 3600 + m * 60 + s;
}
export function slurmBytes(v: string): number | undefined {
  const m = /^([\d.]+)([KMGTP]?)/i.exec(v ?? '');
  if (!m) return undefined;
  const mult: Record<string, number> = { '': 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40, P: 2 ** 50 };
  return Number(m[1]) * mult[m[2].toUpperCase()];
}
/** ReqMem → total bytes for the job. Handles modern ("384000M") and legacy per-cpu/per-node suffixes ("4000Mc"/"4000Mn"). */
export function reqMemTotal(v: string, cpus: number, nodes: number): number | undefined {
  const b = slurmBytes(v);
  if (b === undefined) return undefined;
  if (/c$/i.test(v)) return b * cpus;
  return b * Math.max(1, nodes);
}

// ───────────────────── history (sacct) ─────────────────────
export interface HistRow {
  id: string; name: string; partition: string; state: string; start: string;
  elapsed: number; limit?: number; cpus: number; nodes: number; totalCpu: number;
  reqMem?: number; maxRss?: number; gpus: number;
  cpuEff?: number; memEff?: number; timeEff?: number; hints: string[];
}

export function parseHistory(text: string): HistRow[] {
  const jobs = new Map<string, HistRow>();
  const stepRss = new Map<string, number>();
  for (const line of text.split('\n')) {
    const f = line.split('|');
    if (f.length < 14) continue;
    const [id, name, part, state, elapsed, limit, cpus, totalCpu, reqMem, maxRss, nnodes, start, , tres] = f;
    const base = id.split('.')[0].split('+')[0];
    if (id.includes('.')) {                                        // step: carry MaxRSS up to the job
      const r = slurmBytes(maxRss);
      if (r !== undefined) stepRss.set(base, Math.max(stepRss.get(base) ?? 0, r));
      continue;
    }
    const c = Number(cpus) || 0, n = Number(nnodes) || 1;
    jobs.set(base, {
      id: base, name, partition: part, state: state.split(' ')[0], start,
      elapsed: slurmSeconds(elapsed) ?? 0, limit: slurmSeconds(limit), cpus: c, nodes: n,
      totalCpu: slurmSeconds(totalCpu) ?? 0, reqMem: reqMemTotal(reqMem, c, n),
      gpus: Number(/gres\/gpu(?::[^=,]+)?=(\d+)/.exec(tres ?? '')?.[1] ?? 0), hints: [],
    });
  }
  const hold = cfg().get<string>('holdJobName', 'vscode');
  for (const j of jobs.values()) {
    j.maxRss = stepRss.get(j.id);
    if (j.elapsed > 0 && j.cpus > 0) j.cpuEff = j.totalCpu / (j.elapsed * j.cpus);
    if (j.maxRss !== undefined && j.reqMem) j.memEff = j.maxRss / j.reqMem;
    if (j.limit) j.timeEff = j.elapsed / j.limit;
    const holder = j.name === hold || j.name === 'arc-verify';
    if (j.state.startsWith('OUT_OF_ME')) j.hints.push('Ran out of memory — request more, or use bigmem/compute3.');
    if (j.state === 'TIMEOUT') j.hints.push('Hit the walltime limit — add checkpoint/restart, or use compute2 (240 h).');
    if (holder) j.hints.push('Interactive/holder job — low CPU is expected; release nodes when idle.');
    else {
      if (j.cpuEff !== undefined && j.elapsed > 300 && j.cpuEff < 0.25)
        j.hints.push(`Used ${(j.cpuEff * 100).toFixed(0)}% of ${j.cpus} cores — nodes are exclusive, so run more tasks per node (GNU parallel) or pack jobs.`);
      if (j.timeEff !== undefined && j.state === 'COMPLETED' && j.timeEff < 0.25 && (j.limit ?? 0) > 3600)
        j.hints.push('Requested far more walltime than used — shorter limits usually start sooner.');
      if (j.memEff !== undefined && j.memEff > 0.9) j.hints.push('Peak memory within 10% of the request.');
    }
  }
  return [...jobs.values()].sort((a, b) => (b.start > a.start ? 1 : -1));
}

// ───────────────────── panel ─────────────────────
const label: Record<Mode, string> = {
  'srun-gpu': 'GPU-bound srun step', srun: 'srun --overlap step', ssh: 'node SSH', acct: 'accounting-only mode',
};
type Mode = 'srun-gpu' | 'srun' | 'ssh' | 'acct';
interface Meta { id: string; nodes: number; nodeList: string; gres?: string; [k: string]: unknown }

/** Fallback order. GPU jobs try a GPU-bound step first (so nvidia-smi can see the devices). */
function plan(meta: Meta, overlapOk: boolean): Mode[] {
  const gpu = /gpu/.test(meta.gres ?? '');
  const srun: Mode[] = overlapOk ? (gpu ? ['srun-gpu', 'srun'] : ['srun']) : [];
  return gpu ? [srun[0], 'ssh', ...srun.slice(1), 'acct'].filter(Boolean) as Mode[] : [...srun, 'ssh', 'acct'];
}
const stepGres = (g?: string) => (g ?? '').split(',').map(x => x.replace(/^gres[:/]/, '')).filter(x => x.startsWith('gpu')).join(',');

export class MonitorPanel {
  static current: MonitorPanel | undefined;

  static show(ext: vscode.ExtensionContext, jobId?: string) {
    if (MonitorPanel.current) {
      MonitorPanel.current.panel.reveal();
      if (jobId) void MonitorPanel.current.select(jobId);
      return;
    }
    MonitorPanel.current = new MonitorPanel(ext, jobId);
  }

  private panel: vscode.WebviewPanel;
  private child?: ChildProcess;
  private acctTimer?: NodeJS.Timeout;
  private listTimer?: NodeJS.Timeout;
  private jobId?: string;
  private prev = new Map<string, Raw>();
  private interval = 2;
  private gen = 0;              // bumps on every (re)start so stale streams are ignored
  private disposed = false;

  private constructor(private ext: vscode.ExtensionContext, initialJob?: string) {
    const root = vscode.Uri.joinPath(ext.extensionUri, 'media', 'monitor');
    this.panel = vscode.window.createWebviewPanel('arc.monitor', 'Arc Monitor', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [root] });
    this.panel.iconPath = new vscode.ThemeIcon('pulse');
    this.interval = cfg().get<number>('monitorInterval', 2);
    this.panel.webview.html = this.html(root);
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.post({ type: 'error', text: errMsg(e) })));
    this.jobId = initialJob;
  }

  private post(m: unknown) { if (!this.disposed) void this.panel.webview.postMessage(m); }

  private html(root: vscode.Uri): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(root, 'monitor.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(root, 'monitor.js'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"><title>Arc Monitor</title></head>
<body><div id="app" aria-live="polite"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private async onMessage(m: { type: string; [k: string]: unknown }) {
    switch (m.type) {
      case 'ready':
        await this.sendJobList();
        this.listTimer = setInterval(() => void this.sendJobList().catch(() => undefined), 20_000);
        if (this.jobId) await this.select(this.jobId);
        else {
          const jobs = await getJobs().catch(() => [] as Job[]);
          const pick = jobs.find(j => j.state === 'RUNNING' && j.name !== cfg().get('holdJobName', 'vscode'))
            ?? jobs.find(j => j.state === 'RUNNING');
          if (pick) await this.select(pick.id); else this.post({ type: 'idle' });
        }
        break;
      case 'select': await this.select(String(m.jobId)); break;
      case 'interval':
        this.interval = Math.max(1, Math.min(30, Number(m.seconds) || 2));
        if (this.jobId) await this.select(this.jobId);
        break;
      case 'history': await this.sendHistory(Number(m.days) || 7); break;
      case 'action': {
        const cmd = { details: 'arc.jobDetails', log: 'arc.jobFollow', shell: 'arc.jobShell', cancel: 'arc.jobCancel' }[String(m.action)];
        const job = (await getJobs()).find(j => j.id === String(m.jobId));
        if (cmd && job) await vscode.commands.executeCommand(cmd, { data: job });
        break;
      }
    }
  }

  private async sendJobList() {
    const jobs = await getJobs();
    this.post({ type: 'jobs', jobs: jobs.map(j => ({ id: j.id, name: j.name, state: j.state, partition: j.partition, nodes: j.nodeList })) });
  }

  private stop() {
    this.gen++;
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM');
    this.child = undefined;
    if (this.acctTimer) clearInterval(this.acctTimer);
    this.acctTimer = undefined;
    this.prev.clear();
  }

  async select(jobId: string) {
    this.stop();
    this.jobId = jobId;
    this.panel.title = `Arc Monitor · ${jobId}`;
    const row = (await rr('squeue', ['-h', '-j', jobId, '-o', '%i|%j|%P|%T|%M|%l|%L|%C|%m|%D|%N|%b'])).trim();
    if (!row) {                                   // finished → accounting report card only
      this.post({ type: 'meta', job: { id: jobId, state: 'ENDED' }, mode: 'acct' });
      await this.sendAcct(jobId);
      return;
    }
    const [id, name, partition, state, elapsed, limit, left, cpus, minMem, nnodes, nodeList, gres] = row.split('|');
    const meta: Meta = { id, name, partition, state, elapsed: slurmSeconds(elapsed), limit: slurmSeconds(limit), left, cpus: Number(cpus),
      minMem: slurmBytes(minMem), nodes: Number(nnodes), nodeList, gres, metaAt: Date.now() / 1000 };
    await this.sendAcct(jobId);
    this.acctTimer = setInterval(() => void this.sendAcct(jobId).catch(() => undefined), 15_000);
    if (state !== 'RUNNING') { this.post({ type: 'meta', job: meta, mode: 'acct', note: `Job is ${state.toLowerCase()} — live metrics start when it runs.` }); return; }
    this.startStream(meta, plan(meta, cfg().get<boolean>('srunOverlap', true)));
  }

  private remoteCommand(mode: Mode, meta: Meta): string {
    const life = cfg().get<number>('monitorMaxMinutes', 240) * 60;
    const script = samplerScript(this.ext.extensionPath);
    const inner = `bash -c ${q(script)} arcmon ${this.interval} ${life}`;
    if (mode === 'srun' || mode === 'srun-gpu') {
      const n = Math.max(1, meta.nodes);
      const gres = mode === 'srun-gpu' ? ` --gres=${stepGres(meta.gres)}` : ' --gres=none';
      // One sampler per node, inside the job's allocation. --overlap shares the job's resources;
      // the tiny step costs nothing and ends when this stream closes.
      return `exec srun --jobid=${meta.id} --overlap --nodes=${n} --ntasks=${n} --ntasks-per-node=1 --cpu-bind=none --mem=0${gres} ` +
             `--job-name=arcmon --quiet ${inner}`;
    }
    return `for n in $(scontrol show hostnames ${q(meta.nodeList)}); do ` +
           `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$n" ${q(inner)} & done; wait`;
  }

  private startStream(meta: Meta, modes: Mode[]) {
    const [mode, ...rest] = modes;
    const gen = this.gen;
    this.post({ type: 'meta', job: meta, mode, interval: this.interval });
    if (!mode || mode === 'acct') {
      this.post({ type: 'note', text: 'Live sampling is unavailable for this job (no srun --overlap step and no node SSH). Showing Slurm accounting only.' });
      return;
    }
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', loginHost(), 'bash', '-c', q(this.remoteCommand(mode, meta))]);
    this.child = child;
    let got = 0, stderr = '';
    const next = (why: string) => {
      if (gen !== this.gen || this.disposed) return;
      log(`[monitor] ${mode} failed: ${why}`);
      if (child.exitCode === null) child.kill('SIGTERM');
      this.gen++;                                  // invalidate this stream before starting the next one
      this.prev.clear();
      this.post({ type: 'note', text: `${label[mode]} unavailable — trying ${label[rest[0] ?? 'acct']}…` });
      this.startStream(meta, rest);
    };
    // A step that can't get resources waits silently; don't let it hang the panel.
    const watchdog = setTimeout(() => { if (got === 0) next('no sample within 25 s'); }, 25_000);
    readline.createInterface({ input: child.stdout }).on('line', line => {
      if (gen !== this.gen || !line.startsWith('ARCMON ')) return;
      try {
        const s: Raw = JSON.parse(line.slice(7));
        const d = derive(this.prev.get(s.host), s);
        this.prev.set(s.host, s);
        if (got++ === 0) clearTimeout(watchdog);
        if (d) this.post({ type: 'sample', d });
      } catch (e) { log(`[monitor] bad sample: ${errMsg(e)}`); }
    });
    child.stderr.on('data', b => { stderr += b.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on('close', code => {
      clearTimeout(watchdog);
      if (gen !== this.gen || this.disposed) return;
      if (got === 0) { next(stderr.trim().split('\n').pop() || `exit ${code}`); return; }
      log(`[monitor] ${mode} stream ended (code ${code}) ${stderr.trim()}`);
      this.post({ type: 'note', stopped: true,
        text: `Live stream stopped (${code === 0 ? 'job ended or monitor time cap reached' : stderr.trim().split('\n').pop() || `exit ${code}`}).` });
    });
  }

  private async sendAcct(jobId: string) {
    const [st, sa] = await Promise.all([
      rr('sstat', ['-a', '-n', '-P', '-j', jobId, '--format=JobID,AveCPU,AveRSS,MaxRSS,MaxVMSize,AveDiskRead,AveDiskWrite,MaxDiskRead,MaxDiskWrite']).catch(() => ''),
      rr('sacct', ['-n', '-P', '-j', jobId, '--format=JobID,JobName,Partition,State,Elapsed,Timelimit,AllocCPUS,TotalCPU,ReqMem,MaxRSS,NNodes,Start,End,AllocTRES']).catch(() => ''),
    ]);
    const steps = st.trim() ? st.trim().split('\n').map(l => l.split('|')) : [];
    const hist = parseHistory(sa).find(r => r.id === jobId.split('.')[0]);
    this.post({ type: 'acct', jobId, steps, report: hist });
  }

  private async sendHistory(days: number) {
    this.post({ type: 'historyLoading', days });
    const text = await rr('sacct', ['-u', utsaId(), '-S', `now-${days}days`, '-n', '-P',
      '--format=JobID,JobName,Partition,State,Elapsed,Timelimit,AllocCPUS,TotalCPU,ReqMem,MaxRSS,NNodes,Start,End,AllocTRES'], { timeoutMs: 60_000 });
    const rows = parseHistory(text).filter(r => !/^(PENDING|RUNNING)$/.test(r.state));
    this.post({ type: 'history', days, rows });
  }

  dispose() {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    if (this.listTimer) clearInterval(this.listTimer);
    MonitorPanel.current = undefined;
  }
}
