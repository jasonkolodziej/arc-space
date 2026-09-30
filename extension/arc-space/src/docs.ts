/*
 * Read-only report viewer. Reports (scontrol, sacct, verification, diagnosis) open as
 * virtual documents under the "arc-report" scheme instead of untitled files, so they are
 * never marked dirty, never ask to be saved, and a repeat of the same report reuses its tab.
 */
import * as vscode from 'vscode';

const SCHEME = 'arc-report';
const content = new Map<string, string>();
const changed = new vscode.EventEmitter<vscode.Uri>();

export function registerReports(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(changed, vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    onDidChange: changed.event,
    provideTextDocumentContent: uri => content.get(uri.path) ?? '(report no longer available)',
  }));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';

/** Show a report. `key` identifies the tab to reuse (e.g. "scontrol-822842"); defaults to the title. */
export async function showReport(title: string, body: string, key?: string) {
  const path = `/${slug(key ?? title)}.txt`;
  const uri = vscode.Uri.from({ scheme: SCHEME, path });
  content.set(path, `${title}\n${'─'.repeat(Math.min(title.length, 80))}\n\n${body}\n`);
  changed.fire(uri);                                   // refresh if that tab is already open
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
}
