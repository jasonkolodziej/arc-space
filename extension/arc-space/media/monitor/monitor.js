// Arc Monitor webview. No libraries; DOM built with createElement (CSP: no inline styles/scripts).
(() => {
  const vscode = acquireVsCodeApi();
  const N = 120;                      // history points per series
  const SVG = 'http://www.w3.org/2000/svg';
  const app = document.getElementById('app');

  // ── tiny DOM helpers ──────────────────────────────────
  const el = (tag, cls, ...kids) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k of kids) if (k != null) e.append(k instanceof Node ? k : String(k));
    return e;
  };
  const svg = (tag, attrs = {}) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const meter = (v, kind = '', title) => {
    const m = el('div', `meter ${kind}`), i = el('i');
    i.style.setProperty('--v', String(Math.max(0, Math.min(1, v || 0))));
    m.append(i); m.setAttribute('role', 'meter'); m.setAttribute('aria-valuenow', String(Math.round((v || 0) * 100)));
    m.setAttribute('aria-valuemin', '0'); m.setAttribute('aria-valuemax', '100');
    if (title) m.title = title;
    return m;
  };
  // Efficiency grading. 'use' (CPU/GPU): low = waste. 'fit' (memory/time vs request): near the limit = danger, far under = over-requested.
  const grade = (v, kind) => {
    if (v == null || isNaN(v)) return '';
    if (kind === 'use') return v < 0.25 ? 'g-bad' : v < 0.6 ? 'g-meh' : 'g-good';
    return v > 0.95 ? 'g-bad' : v < 0.25 ? 'g-meh' : 'g-good';
  };
  const box = (cls, title, sub) => { const b = el('section', `box ${cls}`), h = el('h2', null, title); if (sub) h.append(el('span', null, sub)); b.append(h); return b; };

  // ── formatting ────────────────────────────────────────
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const bytes = b => { if (b == null || isNaN(b)) return '—'; let i = 0; while (Math.abs(b) >= 1024 && i < units.length - 1) { b /= 1024; i++; } return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${units[i]}`; };
  const rate = b => `${bytes(b)}/s`;
  const pct = v => (v == null || isNaN(v) ? '—' : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);
  const dur = s => {
    if (s == null || isNaN(s)) return '—';
    s = Math.max(0, Math.round(s));
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
    return d ? `${d}d ${hms}` : hms;
  };

  // ── state ─────────────────────────────────────────────
  const st = {
    tab: 'live', jobs: [], job: null, mode: null, interval: 2, note: null, stopped: false,
    hosts: new Map(), host: null, acct: null, history: null, historyDays: 7, historyLoading: false,
    sort: { key: 'cpu', dir: -1 }, openedAt: null,
    eff: null,
  };
  const newEff = () => ({ cpuSum: 0, n: 0, memPeak: 0, memTotal: 0, gpuSum: 0, gpuN: 0, gpuIdleSince: null, gpuSeen: false });
  const series = () => ({ cpu: [], mem: [], rx: [], tx: [], lr: [], lw: [], gpu: [], gmem: [] });
  const push = (arr, v) => { arr.push(v); if (arr.length > N) arr.shift(); };

  // ── graphs ────────────────────────────────────────────
  let gid = 0;
  function heatDefs(s) {
    const id = `heat${gid++}`;
    const g = svg('linearGradient', { id, x1: 0, y1: 100, x2: 0, y2: 0, gradientUnits: 'userSpaceOnUse' });
    [['0', '--cool'], ['40', '--cool'], ['70', '--warm'], ['100', '--hot']].forEach(([o, c]) =>
      g.append(svg('stop', { offset: `${o}%`, 'stop-color': getComputedStyle(document.documentElement).getPropertyValue(c).trim() })));
    const d = svg('defs'); d.append(g); s.append(d);
    return `url(#${id})`;
  }
  function pathOf(vals, max, flip = false, mid = 100) {
    if (!vals.length) return '';
    const x0 = N - vals.length;
    const y = v => { const h = Math.max(0, Math.min(1, (v || 0) / (max || 1))) * mid; return flip ? mid + h : mid - h; };
    let p = `M${x0},${mid} `;
    vals.forEach((v, i) => { p += `L${x0 + i},${y(v).toFixed(2)} `; });
    return p + `L${x0 + vals.length - 1},${mid} Z`;
  }
  function areaGraph(vals, { max = 1, hero = false, color } = {}) {
    const s = svg('svg', { class: `graph${hero ? ' hero' : ''}`, viewBox: `0 0 ${N - 1} 100`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const fill = color ? `var(${color})` : heatDefs(s);
    [25, 50, 75].forEach(y => s.append(svg('line', { class: 'axis', x1: 0, x2: N, y1: y, y2: y, 'vector-effect': 'non-scaling-stroke' })));
    s.append(svg('path', { d: pathOf(vals, max), fill, 'fill-opacity': color ? 0.35 : 0.55 }));
    const top = svg('path', { class: 'line', d: pathOf(vals, max).replace(/ Z$/, ''), stroke: fill });
    s.append(top);
    return s;
  }
  function mirrorGraph(up, down) {  // btop-style: receive above the axis, transmit below
    const max = Math.max(1, ...up, ...down);
    const s = svg('svg', { class: 'graph', viewBox: `0 0 ${N - 1} 100`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    s.append(svg('line', { class: 'axis', x1: 0, x2: N, y1: 50, y2: 50, 'vector-effect': 'non-scaling-stroke' }));
    s.append(svg('path', { d: pathOf(up, max, false, 50), fill: 'var(--rx)', 'fill-opacity': 0.55 }));
    s.append(svg('path', { d: pathOf(down, max, true, 50), fill: 'var(--tx)', 'fill-opacity': 0.55 }));
    return s;
  }

  // ── header ────────────────────────────────────────────
  function header() {
    const top = el('div', 'top');
    const sel = el('select'); sel.setAttribute('aria-label', 'Job');
    if (!st.jobs.length) sel.append(el('option', null, 'No active jobs'));
    for (const j of st.jobs) {
      const o = el('option', null, `${j.id}  ${j.name}  · ${j.state.toLowerCase()} · ${j.partition}`);
      o.value = j.id; if (st.job && j.id === st.job.id) o.selected = true; sel.append(o);
    }
    if (st.job && !st.jobs.some(j => j.id === st.job.id)) { const o = el('option', null, `${st.job.id}  (ended)`); o.value = st.job.id; o.selected = true; sel.append(o); }
    sel.onchange = () => { st.tab = 'live'; vscode.postMessage({ type: 'select', jobId: sel.value }); };

    const tabs = el('div', 'tabs'); tabs.setAttribute('role', 'tablist');
    for (const [k, label] of [['live', 'Live'], ['history', 'History']]) {
      const b = el('button', null, label); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(st.tab === k));
      b.onclick = () => { st.tab = k; if (k === 'history' && !st.history && !st.historyLoading) vscode.postMessage({ type: 'history', days: st.historyDays }); render(); };
      tabs.append(b);
    }
    top.append(sel, tabs);

    if (st.tab === 'live') {
      if (st.hosts.size > 1) {
        const chips = el('div', 'chips');
        for (const h of st.hosts.keys()) {
          const c = el('button', 'chip', h); c.setAttribute('aria-pressed', String(h === st.host));
          c.onclick = () => { st.host = h; render(); }; chips.append(c);
        }
        top.append(chips);
      }
      const iv = el('select'); iv.setAttribute('aria-label', 'Refresh interval');
      for (const s of [1, 2, 5, 10]) { const o = el('option', null, `every ${s}s`); o.value = String(s); if (s === st.interval) o.selected = true; iv.append(o); }
      iv.onchange = () => { st.interval = Number(iv.value); vscode.postMessage({ type: 'interval', seconds: st.interval }); };
      top.append(iv);
    }
    top.append(el('div', 'spacer'));
    if (st.job && st.job.state !== 'ENDED') {
      const acts = el('div', 'actions');
      const act = (label, action, cls) => { const b = el('button', cls, label); b.onclick = () => vscode.postMessage({ type: 'action', action, jobId: st.job.id }); return b; };
      acts.append(act('Details', 'details'), act('Follow log', 'log'));
      if (st.job.state === 'RUNNING') acts.append(act('Shell', 'shell'));
      acts.append(act('Cancel job', 'cancel', 'danger'));
      top.append(acts);
    }
    const status = el('div', 'status');
    if (st.tab === 'live' && st.job) {
      const how = { 'srun-gpu': 'sampling inside the job (srun step with GPUs)', srun: 'sampling inside the job (srun step)', ssh: 'sampling over node SSH', acct: 'Slurm accounting only' }[st.mode] || '';
      status.append(el('b', null, `${st.job.name || st.job.id}`), ` on ${st.job.nodeList || '—'} · ${how}${st.note ? ' · ' + st.note : ''}`);
    }
    top.append(status);
    return top;
  }

  // ── live view ─────────────────────────────────────────
  function timeInfo() {
    const j = st.job; if (!j || j.elapsed == null) return {};
    const elapsed = j.elapsed + (Date.now() / 1000 - j.metaAt);
    return { elapsed, limit: j.limit, frac: j.limit ? elapsed / j.limit : null };
  }

  function effStrip() {
    const e = st.eff, wrap = el('div', 'eff');
    const cell = (k, v, sub, m, title, kind = '') => { const c = el('div'); c.append(el('div', 'k', k), el('div', 'v', v), el('div', 's', sub || '')); if (m != null) c.append(meter(m, kind, title)); if (title) c.title = title; return c; };
    const cpuAvg = e && e.n ? e.cpuSum / e.n : null;
    const cores = st.job?.cpus;
    wrap.append(cell('CPU used, average', pct(cpuAvg), cores ? `of ${cores} cores, since opened` : 'since opened', cpuAvg,
      'Average busy share of the job\'s cores since this monitor opened', grade(cpuAvg, 'use')));
    wrap.append(cell('Peak memory', bytes(e?.memPeak), e?.memTotal ? `of ${bytes(e.memTotal)}` : '', e?.memTotal ? e.memPeak / e.memTotal : null));
    const t = timeInfo();
    wrap.append(cell('Walltime', dur(t.elapsed), t.limit ? `of ${dur(t.limit)}` : '', t.frac));
    if (e?.gpuSeen) { const g = e.gpuN ? e.gpuSum / e.gpuN : null; wrap.append(cell('GPU used, average', pct(g), 'since opened', g, null, grade(g, 'use'))); }
    const r = st.acct?.report;
    if (r?.cpuEff != null) wrap.append(cell('Slurm CPU efficiency', pct(r.cpuEff), 'finished steps only', r.cpuEff,
      'TotalCPU ÷ (elapsed × allocated cores) from sacct; counts only completed steps', grade(r.cpuEff, 'use')));
    return wrap;
  }

  function cpuBox(h) {
    const d = h.last, b = box('cpu', 'cpu', d ? `${d.ncpu} cores · load ${d.load.map(x => x.toFixed(2)).join(' ')}` : '');
    const wrap = el('div', 'hero-wrap');
    wrap.append(areaGraph(h.s.cpu, { hero: true }));
    const ro = el('div', 'readout');
    const big = el('div', 'big', d ? (d.cpu * 100).toFixed(0) : '—', el('small', null, '%'));
    ro.append(big, el('div', 'sub', d ? `iowait ${pct(d.iowait)}` : 'waiting for samples…'));
    wrap.append(ro); b.append(wrap);
    if (d) {
      const cores = el('div', 'cores');
      d.cores.forEach((v, i) => { const c = el('div', 'core', String(i)); c.append(meter(v), el('b', null, (v * 100).toFixed(0))); cores.append(c); });
      b.append(cores);
    }
    return b;
  }

  function memBox(h) {
    const d = h.last, b = box('mem', 'mem', d ? bytes(d.mem.total) : '');
    b.append(areaGraph(h.s.mem));
    if (d) {
      const m = d.mem, rows = el('div', 'rows');
      const row = (n, v, frac, kind) => { const r = el('div', 'row'); r.append(el('span', 'n', n), meter(frac, kind), el('span', 'x', v)); return r; };
      rows.append(row('used', bytes(m.used), m.used / m.total), row('cache', bytes(m.cached), m.cached / m.total, 'neutral'),
        row('free', bytes(m.total - m.used), (m.total - m.used) / m.total, 'faint'));
      if (m.swapTotal) rows.append(row('swap', bytes(m.swapUsed), m.swapUsed / m.swapTotal));
      if (d.procTotals) rows.append(el('div', 'muted', `your processes: ${d.procTotals.count} · ${d.procTotals.threads} threads · ${bytes(d.procTotals.rss)} RSS`));
      b.append(rows);
    }
    return b;
  }

  function gpuBox(h) {
    const d = h.last, b = box('gpu', 'gpu');
    const wantsGpu = /gpu/.test(st.job?.gres || '');
    if (!d || !d.gpu.length) {
      b.append(el('div', 'muted', wantsGpu
        ? 'The job has GPUs but the monitor can\'t see them from its sampling step. GPU metrics need node SSH or a GPU-bound step.'
        : 'No GPUs on this node.'));
      return b;
    }
    b.append(areaGraph(h.s.gpu, { max: 100 }));
    for (const g of d.gpu) {
      const c = el('div', 'gpucard'), rows = el('div', 'rows');
      c.append(el('div', 'muted', `#${g.i} ${g.name}`));
      const row = (n, v, frac) => { const r = el('div', 'row'); r.append(el('span', 'n', n), meter(frac), el('span', 'x', v)); return r; };
      rows.append(row('util', `${g.util}%`, g.util / 100), row('memory', `${bytes(g.memUsed)} / ${bytes(g.memTotal)}`, g.memUsed / (g.memTotal || 1)),
        row('power', g.power ? `${g.power.toFixed(0)} / ${g.powerLimit.toFixed(0)} W` : '—', g.powerLimit ? g.power / g.powerLimit : 0),
        row('temp', `${g.temp}°C`, g.temp / 90));
      c.append(rows); b.append(c);
    }
    return b;
  }

  function sumRates(list) { return list.reduce((a, x) => ({ rx: a.rx + x.rx, tx: a.tx + x.tx }), { rx: 0, tx: 0 }); }

  function netBox(h) {
    const d = h.last, b = box('net', 'net', 'receive ↑ · send ↓');
    b.append(mirrorGraph(h.s.rx, h.s.tx));
    if (d) {
      const rows = el('div', 'rows');
      const list = [...d.ib.map(x => ({ ...x, name: `ib ${x.name}` })), ...d.net];
      for (const n of list.slice(0, 6)) {
        const r = el('div', 'pair'); r.append(el('span', 'n muted', n.name), el('span', 'rx', `↑ ${rate(n.rx)}`), el('span', 'tx', `↓ ${rate(n.tx)}`)); rows.append(r);
      }
      if (!d.ib.length) rows.append(el('div', 'muted', 'InfiniBand counters not readable on this node.'));
      b.append(rows);
    }
    return b;
  }

  function ioBox(h) {
    const d = h.last, b = box('io', 'io', 'read ↑ · write ↓');
    b.append(mirrorGraph(h.s.lr, h.s.lw));
    if (d) {
      const rows = el('div', 'rows');
      const line = (name, x) => { const r = el('div', 'pair'); r.append(el('span', 'n muted', name), el('span', 'rx', `↑ ${rate(x.rx)}`), el('span', 'tx', `↓ ${rate(x.tx)}`)); return r; };
      if (d.lustre.length) d.lustre.forEach(l => rows.append(line(`/${l.name}`, l)));
      else rows.append(el('div', 'muted', 'Lustre client stats not readable; showing local disks only.'));
      if (d.disk.length) rows.append(line('local disk', sumRates(d.disk)));
      b.append(rows);
    }
    return b;
  }

  function slurmBox() {
    const b = box('slurm', 'slurm', 'sstat · refreshed every 15 s');
    const t = timeInfo();
    if (t.limit) { const r = el('div', 'row'); r.append(el('span', 'n', 'walltime'), meter(t.frac), el('span', 'x', `${dur(t.limit - t.elapsed)} left`)); b.append(r); }
    const steps = st.acct?.steps || [];
    if (!steps.length) { b.append(el('div', 'muted', 'No running steps reported yet.')); return b; }
    const tw = el('div', 'tablewrap'), tbl = el('table'), hr = el('tr');
    ['step', 'avg cpu', 'max rss', 'read', 'write'].forEach((c, i) => hr.append(el('th', i ? 'num' : '', c)));
    tbl.append(hr);
    for (const s of steps) {
      const tr = el('tr');
      [s[0].replace(/^\d+\./, '.'), s[1], s[3], s[7] || s[5], s[8] || s[6]].forEach((v, i) => tr.append(el('td', i ? 'num' : '', v || '—')));
      tbl.append(tr);
    }
    tw.append(tbl); b.append(tw);
    return b;
  }

  function procBox(h) {
    const d = h.last, b = box('procs', 'processes', d ? `${d.procTotals.count} yours on ${d.host} · current CPU%, 100% = one core` : '');
    if (!d) { b.append(el('div', 'muted', 'waiting for samples…')); return b; }
    const cols = [['pid', 'pid', true], ['cmd', 'command', false], ['cpu', 'cpu%', true], ['mem', 'mem%', true], ['rss', 'rss', true], ['threads', 'thr', true], ['age', 'running', true]];
    const tw = el('div', 'tablewrap'), tbl = el('table'), hr = el('tr');
    for (const [k, label, num] of cols) {
      const th = el('th', num ? 'num' : ''), btn = el('button', null, label + (st.sort.key === k ? (st.sort.dir < 0 ? ' ▾' : ' ▴') : ''));
      if (st.sort.key === k) btn.setAttribute('aria-sort', st.sort.dir < 0 ? 'descending' : 'ascending');
      btn.onclick = () => { st.sort = { key: k, dir: st.sort.key === k ? -st.sort.dir : (num ? -1 : 1) }; render(); };
      th.append(btn); hr.append(th);
    }
    tbl.append(hr);
    const rows = [...d.procs].sort((a, b) => { const x = a[st.sort.key], y = b[st.sort.key]; return (x > y ? 1 : x < y ? -1 : 0) * st.sort.dir; });
    for (const p of rows.slice(0, 30)) {
      const tr = el('tr', p.cpu > 90 ? 'hot' : '');
      const cpuCell = el('td', 'num cpu'); cpuCell.append(meter(Math.min(1, p.cpu / 100), 'thin'), p.cpu.toFixed(1));
      tr.append(el('td', 'num', p.pid), el('td', 'cmd', p.cmd), cpuCell, el('td', 'num', p.mem.toFixed(1)), el('td', 'num', bytes(p.rss)), el('td', 'num', p.threads), el('td', 'num', dur(p.age)));
      tr.children[1].title = p.cmd;
      tbl.append(tr);
    }
    tw.append(tbl); b.append(tw);
    return b;
  }

  function reportCard() {   // ended / pending job: accounting only
    const r = st.acct?.report, wrap = el('div');
    if (!r) { wrap.append(el('div', 'empty', st.note || 'No accounting data yet for this job.')); return wrap; }
    const cells = el('div', 'eff');
    const cell = (k, v, sub, m, kind = '') => { const c = el('div'); c.append(el('div', 'k', k), el('div', 'v', v), el('div', 's', sub || '')); if (m != null) c.append(meter(m, kind)); return c; };
    cells.append(cell('CPU efficiency', pct(r.cpuEff), `of ${r.cpus} cores`, r.cpuEff, grade(r.cpuEff, 'use')),
      cell('Peak memory', bytes(r.maxRss), r.reqMem ? `of ${bytes(r.reqMem)} requested` : '', r.memEff, grade(r.memEff, 'fit')),
      cell('Walltime used', dur(r.elapsed), r.limit ? `of ${dur(r.limit)}` : '', r.timeEff, grade(r.timeEff, 'fit')),
      cell('State', r.state.toLowerCase(), `${r.partition} · ${r.nodes} node${r.nodes > 1 ? 's' : ''}${r.gpus ? ` · ${r.gpus} GPU` : ''}`));
    wrap.append(cells);
    if (r.hints.length) { const ul = el('div', 'rows'); r.hints.forEach(h => ul.append(el('div', 'hint', h))); wrap.append(ul); }
    if (st.note) wrap.append(el('div', 'banner info', st.note));
    return wrap;
  }

  function live() {
    const frag = document.createDocumentFragment();
    if (!st.job) {
      const e = el('div', 'empty', 'No running job selected. Pick one above, or open History to review finished jobs.');
      frag.append(e); return frag;
    }
    const h = st.hosts.get(st.host);
    if ((st.mode === 'acct' || !h) && st.job.state !== 'RUNNING') { frag.append(reportCard()); return frag; }
    frag.append(effStrip());
    const e = st.eff;
    if (e?.gpuIdleSince && Date.now() - e.gpuIdleSince > 20 * 60_000) {
      frag.append(el('div', 'banner', `GPUs have been idle for ${Math.round((Date.now() - e.gpuIdleSince) / 60_000)} min. Arc terminates GPU jobs that stay idle for more than 1 hour.`));
    }
    if (st.mode === 'acct') frag.append(el('div', 'banner info', st.note || 'Live sampling unavailable — showing Slurm accounting only.'));
    const g = el('div', 'grid');
    const hh = h || { s: series(), last: null };
    g.append(cpuBox(hh), memBox(hh), gpuBox(hh), netBox(hh), ioBox(hh), slurmBox(), procBox(hh));
    frag.append(g);
    return frag;
  }

  // ── history view ──────────────────────────────────────
  function history() {
    const frag = document.createDocumentFragment();
    const bar = el('div', 'top'), days = el('select'); days.setAttribute('aria-label', 'Period');
    for (const d of [1, 7, 30, 90]) { const o = el('option', null, `last ${d} day${d > 1 ? 's' : ''}`); o.value = String(d); if (d === st.historyDays) o.selected = true; days.append(o); }
    days.onchange = () => { st.historyDays = Number(days.value); st.historyLoading = true; vscode.postMessage({ type: 'history', days: st.historyDays }); render(); };
    bar.append(days); frag.append(bar);
    if (st.historyLoading) { frag.append(el('div', 'empty', 'Loading sacct…')); return frag; }
    const rows = st.history || [];
    if (!rows.length) { frag.append(el('div', 'empty', `No finished jobs in the last ${st.historyDays} day(s).`)); return frag; }

    const work = rows.filter(r => r.elapsed > 0);
    const coreH = work.reduce((a, r) => a + r.elapsed * r.cpus, 0) / 3600;
    const usedH = work.reduce((a, r) => a + r.totalCpu, 0) / 3600;
    const reqH = work.reduce((a, r) => a + (r.limit || 0), 0) / 3600, wallH = work.reduce((a, r) => a + r.elapsed, 0) / 3600;
    const failed = rows.filter(r => /FAIL|OUT_OF_ME|TIMEOUT|NODE_FAIL/.test(r.state)).length;
    const sum = el('div', 'summary');
    const cell = (k, v, sub, m, kind = '') => { const c = el('div'); c.append(el('div', 'k', k), el('div', 'v', v), el('div', 's', sub || '')); if (m != null) c.append(meter(m, kind)); return c; };
    const useFrac = coreH ? usedH / coreH : null, wallFrac = reqH ? wallH / reqH : null;
    sum.append(cell('Finished jobs', String(rows.length), failed ? `${failed} failed, timed out or ran out of memory` : 'none failed'),
      cell('Core-hours used', `${usedH.toFixed(1)} of ${coreH.toFixed(1)}`, `${pct(useFrac)} of allocated cores kept busy`, useFrac, grade(useFrac, 'use')),
      cell('Walltime used', `${wallH.toFixed(1)} of ${reqH.toFixed(1)} h`, `${pct(wallFrac)} of the walltime you requested`, wallFrac, grade(wallFrac, 'fit')));
    frag.append(sum);

    const tw = el('div', 'tablewrap'), tbl = el('table'), hr = el('tr');
    [['job', ''], ['name', ''], ['partition', ''], ['state', ''], ['walltime', 'num'], ['cores', 'num'], ['cpu eff', ''], ['mem eff', ''], ['time used', ''], ['notes', '']]
      .forEach(([c, cls]) => hr.append(el('th', cls, c)));
    tbl.append(hr);
    for (const r of rows) {
      const tr = el('tr', 'click'); tr.tabIndex = 0;
      const effCell = (v, kind) => { const td = el('td'); td.append(meter(v ?? 0, grade(v, kind)), v == null ? '—' : pct(v)); return td; };
      tr.append(el('td', null, r.id), el('td', 'cmd', r.name), el('td', null, r.partition), el('td', null, r.state.toLowerCase()),
        el('td', 'num', dur(r.elapsed)), el('td', 'num', r.cpus), effCell(r.cpuEff, 'use'), effCell(r.memEff, 'fit'), effCell(r.timeEff, 'fit'),
        el('td', 'hint', r.hints[0] || ''));
      if (r.hints.length > 1) tr.lastChild.title = r.hints.join('\n');
      const open = () => { st.tab = 'live'; vscode.postMessage({ type: 'select', jobId: r.id }); render(); };
      tr.onclick = open; tr.onkeydown = e => { if (e.key === 'Enter') open(); };
      tbl.append(tr);
    }
    tw.append(tbl); frag.append(tw);
    return frag;
  }

  // ── render ────────────────────────────────────────────
  let raf = 0;
  function render() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const y = window.scrollY;
      app.replaceChildren(header(), st.tab === 'live' ? live() : history());
      window.scrollTo(0, y);
    });
  }

  // ── messages from the extension ──────────────────────
  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'jobs': st.jobs = m.jobs; break;
      case 'idle': st.job = null; st.note = null; break;
      case 'meta': {
        const same = st.job && st.job.id === m.job.id;
        st.job = m.job; st.mode = m.mode; if (m.interval) st.interval = m.interval; st.note = m.note || null; st.stopped = false;
        if (!same) { st.hosts = new Map(); st.host = null; st.acct = null; st.eff = newEff(); }
        break;
      }
      case 'note': st.note = m.text; st.stopped = !!m.stopped; break;
      case 'sample': {
        const d = m.d;
        let h = st.hosts.get(d.host);
        if (!h) { h = { s: series(), last: null }; st.hosts.set(d.host, h); if (!st.host) st.host = d.host; }
        h.last = d;
        push(h.s.cpu, d.cpu); push(h.s.mem, d.mem.used / d.mem.total);
        const net = sumRates([...d.net, ...d.ib]); push(h.s.rx, net.rx); push(h.s.tx, net.tx);
        const io = sumRates([...d.lustre, ...d.disk]); push(h.s.lr, io.rx); push(h.s.lw, io.tx);
        if (d.gpu.length) push(h.s.gpu, d.gpu.reduce((a, g) => a + g.util, 0) / d.gpu.length);
        const e = st.eff || (st.eff = newEff());
        e.cpuSum += d.cpu; e.n++;
        // peak/total across hosts: track the busiest host's view
        e.memPeak = Math.max(e.memPeak, d.mem.used); e.memTotal = Math.max(e.memTotal, d.mem.total);
        if (d.gpu.length) {
          e.gpuSeen = true;
          const avg = d.gpu.reduce((a, g) => a + g.util, 0) / d.gpu.length;
          e.gpuSum += avg / 100; e.gpuN++;
          const idle = d.gpu.every(g => g.util < 5);
          e.gpuIdleSince = idle ? (e.gpuIdleSince ?? Date.now()) : null;
        }
        break;
      }
      case 'acct': if (!st.job || m.jobId === st.job.id) st.acct = m; break;
      case 'historyLoading': st.historyLoading = true; break;
      case 'history': st.history = m.rows; st.historyLoading = false; break;
      case 'error': st.note = m.text; break;
    }
    render();
  });

  vscode.postMessage({ type: 'ready' });
  render();
})();
