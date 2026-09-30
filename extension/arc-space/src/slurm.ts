import { rr, runRemote, cfg, utsaId } from './transport';

export interface Partition {
  name: string; avail: string; timeLimit: string; cpus: number; memGB: number;
  gres: string; states: Map<string, number>; total: number;
}
export interface NodeInfo { name: string; state: string; cpus: number; memGB: number; gres: string; }
export interface Job {
  id: string; name: string; partition: string; state: string; elapsed: string;
  left: string; nodes: number; where: string; nodeList: string;
}

export const baseState = (s: string) => s.replace(/[*~#!%$@^+\-]+$/, '').toLowerCase();
const leadingInt = (s: string) => parseInt(s, 10) || 0;

export function gpuGres(gres: string): string | undefined {
  return gres.replace(/\([^)]*\)/g, '').split(',').map(x => x.trim()).find(x => x.startsWith('gpu'));
}

export async function getPartitions(): Promise<Partition[]> {
  const hidden = new Set(cfg().get<string[]>('hiddenPartitions', []));
  const text = await rr('sinfo', ['-h', '-o', '%P|%a|%l|%c|%m|%G|%t|%D']);
  const map = new Map<string, Partition>();
  for (const line of text.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 8) continue;
    const name = f[0].replace(/\*$/, '');
    if (hidden.has(name)) continue;
    let p = map.get(name);
    if (!p) {
      p = { name, avail: f[1], timeLimit: f[2], cpus: leadingInt(f[3]), memGB: Math.round(leadingInt(f[4]) / 1024),
            gres: f[5] === '(null)' ? '' : f[5], states: new Map(), total: 0 };
      map.set(name, p);
    }
    const st = baseState(f[6]);
    const n = Number(f[7]) || 0;
    p.states.set(st, (p.states.get(st) ?? 0) + n);
    p.total += n;
  }
  return [...map.values()];
}

export async function getNodes(partition: string): Promise<NodeInfo[]> {
  const text = await rr('sinfo', ['-h', '-N', '-p', partition, '-o', '%N|%t|%c|%m|%G']);
  const seen = new Map<string, NodeInfo>();
  for (const line of text.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 5) continue;
    seen.set(f[0], { name: f[0], state: baseState(f[1]), cpus: leadingInt(f[2]),
      memGB: Math.round(leadingInt(f[3]) / 1024), gres: f[4] === '(null)' ? '' : f[4] });
  }
  const rank = (s: string) => (s === 'idle' ? 0 : s === 'mix' ? 1 : s === 'alloc' ? 2 : 3);
  return [...seen.values()].sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

export async function getJobs(): Promise<Job[]> {
  const text = await rr('squeue', ['-h', '-u', utsaId(), '-o', '%i|%j|%P|%T|%M|%L|%D|%R|%N']);
  const jobs: Job[] = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 9) continue;
    jobs.push({ id: f[0], name: f[1], partition: f[2], state: f[3], elapsed: f[4], left: f[5],
      nodes: Number(f[6]) || 0, where: f[7], nodeList: f[8] });
  }
  return jobs;
}

export async function scontrolField(id: string, field: string): Promise<string | undefined> {
  const t = await rr('scontrol', ['show', 'job', id]);
  return t.split(/\s+/).find(x => x.startsWith(`${field}=`))?.slice(field.length + 1);
}

export function holderArgs(o: { name: string; p: Partition; time: string; gpu?: string }): string[] {
  const a = ['--parsable', '-J', o.name, '-p', o.p.name, '-t', o.time, '-N', '1', '-n', '1',
    '-c', String(o.p.cpus || 1), '-o', `/home/${utsaId()}/.arc/logs/%x-%j.log`];
  if (o.gpu) a.push(`--gres=${o.gpu}`);
  a.push('--wrap', 'sleep infinity');
  return a;
}

export async function submitHolder(o: { name: string; p: Partition; time: string; gpu?: string }): Promise<string> {
  await runRemote('mkdir -p ~/.arc/logs');
  return (await rr('sbatch', holderArgs(o))).trim().split(';')[0];
}

export function leftMinutes(l: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(l);
  if (!m) return Infinity;
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3]);
}
