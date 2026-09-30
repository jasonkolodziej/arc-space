/*
 * Three-way settings merge:  baseline (what we applied last time) · current (yours) · template (what we'd apply now)
 *
 *  - key/sub-key absent, never applied before  → add         (pre-selected)
 *  - key/sub-key absent, but we applied it      → you removed it → left alone
 *  - scalar differs, current == baseline        → template update (pre-selected)
 *  - scalar differs, current != baseline        → your edit  → conflict (NOT pre-selected)
 *  - object sub-keys / array items              → merged member-by-member with the same rules
 *
 * Nothing is written without an explicit pick in the review list, and writes go through the
 * configuration API (never raw file edits), so comments and unrelated settings are untouched.
 */
import * as vscode from 'vscode';

type Json = unknown;
type Obj = Record<string, Json>;
export interface Baseline { version: number; values: Obj; }

export interface Change {
  key: string;
  kind: 'add' | 'extend' | 'update' | 'conflict' | 'removed';
  next: Json;
  detail: string;
  preselect: boolean;
}

const isObj = (v: Json): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const canon = (v: Json): string =>
  isObj(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v);
const eq = (a: Json, b: Json) => canon(a) === canon(b);
const show = (v: Json) => { const s = JSON.stringify(v); return s.length > 60 ? s.slice(0, 57) + '…' : s; };

function scopeValue(key: string, target: vscode.ConfigurationTarget): Json {
  const i = vscode.workspace.getConfiguration().inspect(key);
  return target === vscode.ConfigurationTarget.Global ? i?.globalValue : i?.workspaceValue;
}

export function planMerge(template: Obj, baseline: Baseline | undefined, target: vscode.ConfigurationTarget): Change[] {
  const base = baseline?.values ?? {};
  const changes: Change[] = [];

  for (const [key, want] of Object.entries(template)) {
    const cur = scopeValue(key, target);
    const had = key in base;
    const was = base[key];

    if (cur === undefined) {
      if (!had) changes.push({ key, kind: 'add', next: want, detail: `add ${show(want)}`, preselect: true });
      else if (!eq(was, want)) changes.push({ key, kind: 'removed', next: want, detail: `you removed this; template now ${show(want)}`, preselect: false });
      continue;
    }

    if (isObj(want) && isObj(cur)) {
      const b = isObj(was) ? was : {};
      const next: Obj = { ...cur };
      const added: string[] = [], updated: string[] = [], kept: string[] = [];
      for (const [k, v] of Object.entries(want)) {
        if (!(k in cur)) {
          if (!(k in b)) { next[k] = v; added.push(k); }          // new in template
          // else: you deleted a sub-key we had applied → respect it
        } else if (!eq(cur[k], v)) {
          if (k in b && eq(cur[k], b[k])) { next[k] = v; updated.push(k); } // untouched by you, template changed
          else kept.push(k);                                               // your value wins
        }
      }
      if (added.length || updated.length) {
        const parts = [added.length && `+${added.length} (${added.slice(0, 3).join(', ')}${added.length > 3 ? '…' : ''})`,
                       updated.length && `~${updated.length} updated`,
                       kept.length && `${kept.length} of yours kept`].filter(Boolean);
        changes.push({ key, kind: 'extend', next, detail: parts.join(' · '), preselect: true });
      }
      continue;
    }

    if (Array.isArray(want) && Array.isArray(cur)) {
      const b = Array.isArray(was) ? was : [];
      const missing = want.filter(x => !cur.some(c => eq(c, x)) && !b.some(y => eq(y, x)));
      if (missing.length) changes.push({ key, kind: 'extend', next: [...cur, ...missing], detail: `+ ${show(missing)}`, preselect: true });
      continue;
    }

    if (!eq(cur, want)) {
      if (had && eq(cur, was)) changes.push({ key, kind: 'update', next: want, detail: `${show(cur)} → ${show(want)}`, preselect: true });
      else changes.push({ key, kind: 'conflict', next: want, detail: `yours: ${show(cur)} · template: ${show(want)}`, preselect: false });
    }
  }
  return changes;
}

const icon: Record<Change['kind'], string> = {
  add: '$(add)', extend: '$(diff-added)', update: '$(arrow-up)', conflict: '$(warning)', removed: '$(trash)',
};

/**
 * Show the review list and apply what the user picks. Returns the number applied,
 * or undefined if the user dismissed the list.
 */
export async function reviewAndApply(
  title: string, template: Obj, baseline: Baseline | undefined, target: vscode.ConfigurationTarget,
  saveBaseline: (b: Baseline) => Thenable<void> | Promise<void>, version: number,
): Promise<number | undefined> {
  const changes = planMerge(template, baseline, target);
  if (!changes.length) {
    await saveBaseline({ version, values: template });
    vscode.window.showInformationMessage(`${title}: already up to date.`);
    return 0;
  }
  const picks = await vscode.window.showQuickPick(
    changes.map(c => ({ label: `${icon[c.kind]} ${c.key}`, description: c.kind, detail: c.detail, picked: c.preselect, c })),
    { canPickMany: true, title: `${title} — ${changes.length} change(s). Unticked items keep your current value.`, ignoreFocusOut: true });
  if (!picks) return undefined;

  const conf = vscode.workspace.getConfiguration();
  for (const p of picks) await conf.update(p.c.key, p.c.next, target);
  // Baseline = the full template, so anything you declined is remembered as declined next time.
  await saveBaseline({ version, values: template });
  return picks.length;
}
