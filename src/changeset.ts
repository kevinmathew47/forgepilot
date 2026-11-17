import * as vscode from "vscode";
import { applyTextEdits, TextEdit } from "./editing";
import { computeHunks, finalText, Hunk } from "./hunks";
import { readDiskOrBuffer, resolvePath, toRelative } from "./workspace";

export interface StagedFile {
  path: string;
  uri: vscode.Uri;
  original: string;
  proposed: string;
  existed: boolean;
}

export class Changeset {
  readonly files = new Map<string, StagedFile>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  async readCurrent(rel: string): Promise<{ text: string; staged: boolean } | undefined> {
    const key = toRelative(rel);
    const staged = this.files.get(key);
    if (staged) return { text: staged.proposed, staged: true };
    const text = await readDiskOrBuffer(resolvePath(key));
    return text === undefined ? undefined : { text, staged: false };
  }

  private async base(rel: string): Promise<StagedFile> {
    const key = toRelative(rel);
    const existing = this.files.get(key);
    if (existing) return existing;
    const uri = resolvePath(key);
    const text = await readDiskOrBuffer(uri);
    return { path: key, uri, original: text ?? "", proposed: text ?? "", existed: text !== undefined };
  }

  async stageEdits(rel: string, edits: TextEdit[]): Promise<StagedFile> {
    const file = await this.base(rel);
    if (!file.existed && !this.files.has(file.path)) {
      throw new Error(`${file.path} does not exist. Use write_file to create it.`);
    }
    const next = applyTextEdits(file.proposed, edits, file.path);
    file.proposed = next;
    this.files.set(file.path, file);
    this.changed.fire();
    return file;
  }

  async stageWrite(rel: string, content: string): Promise<StagedFile> {
    const file = await this.base(rel);
    const eol = file.original.includes("\r\n") ? "\r\n" : "\n";
    file.proposed = content.replace(/\r?\n/g, eol);
    this.files.set(file.path, file);
    this.changed.fire();
    return file;
  }

  unstage(rel: string): boolean {
    const removed = this.files.delete(toRelative(rel));
    if (removed) this.changed.fire();
    return removed;
  }

  discardAll(): number {
    const n = this.files.size;
    this.files.clear();
    if (n) this.changed.fire();
    return n;
  }

  get isEmpty(): boolean {
    return [...this.files.values()].every((f) => f.original === f.proposed);
  }

  hunksByFile(): Map<string, Hunk[]> {
    const out = new Map<string, Hunk[]>();
    for (const f of this.files.values()) {
      const hunks = computeHunks(f.original, f.proposed);
      if (hunks.length) out.set(f.path, hunks);
    }
    return out;
  }
}

export interface AppliedFile {
  uri: vscode.Uri;
  path: string;
  before: string | undefined;
  after: string;
}

export interface AppliedChange {
  label: string;
  at: number;
  files: AppliedFile[];
}

export class History {
  private readonly stack: AppliedChange[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  get last(): AppliedChange | undefined {
    return this.stack[this.stack.length - 1];
  }

  get size(): number {
    return this.stack.length;
  }

  push(change: AppliedChange) {
    this.stack.push(change);
    this.changed.fire();
  }

  async undoLast(): Promise<AppliedChange | undefined> {
    const change = this.stack[this.stack.length - 1];
    if (!change) return undefined;
    const drift: string[] = [];
    for (const f of change.files) {
      const now = await readDiskOrBuffer(f.uri);
      if (now !== f.after) drift.push(f.path);
    }
    if (drift.length) {
      const choice = await vscode.window.showWarningMessage(
        `These files changed after ForgePilot applied "${change.label}": ${drift.join(", ")}. Undo anyway and lose those later edits?`,
        { modal: true },
        "Undo anyway",
      );
      if (choice !== "Undo anyway") return undefined;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const f of change.files) {
      if (f.before === undefined) {
        edit.deleteFile(f.uri, { ignoreIfNotExists: true });
      } else {
        const doc = await vscode.workspace.openTextDocument(f.uri);
        edit.replace(f.uri, new vscode.Range(0, 0, doc.lineCount, 0), f.before);
      }
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error("VS Code refused the undo edit.");
    for (const f of change.files) {
      if (f.before !== undefined) await saveUri(f.uri);
    }
    this.stack.pop();
    this.changed.fire();
    return change;
  }
}

export async function saveUri(uri: vscode.Uri) {
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.isDirty) await doc.save();
}

export async function applyReviewed(
  files: { file: StagedFile; hunks: Hunk[] }[],
  label: string,
): Promise<AppliedChange> {
  const edit = new vscode.WorkspaceEdit();
  const applied: AppliedFile[] = [];
  for (const { file, hunks } of files) {
    if (!hunks.some((h) => h.state === "accepted")) continue;
    const after = finalText(file.original, hunks);
    const current = await readDiskOrBuffer(file.uri);
    if (current !== undefined && current !== file.original && file.existed) {
      throw new Error(`${file.path} changed on disk while the review was open. Nothing was applied.`);
    }
    if (!file.existed) {
      edit.createFile(file.uri, { overwrite: false, ignoreIfExists: false, contents: Buffer.from(after, "utf8") });
    } else {
      const doc = await vscode.workspace.openTextDocument(file.uri);
      edit.replace(file.uri, new vscode.Range(0, 0, doc.lineCount, 0), after);
    }
    applied.push({ uri: file.uri, path: file.path, before: file.existed ? file.original : undefined, after });
  }
  if (!applied.length) return { label, at: Date.now(), files: [] };
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error("VS Code refused the edit. Nothing was applied.");
  for (const f of applied) await saveUri(f.uri);
  return { label, at: Date.now(), files: applied };
}
