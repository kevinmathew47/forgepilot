import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { createTwoFilesPatch } from "diff";
import { ContextEngine, Selection } from "./contextEngine";
import { applyReviewed, Changeset, History } from "./changeset";
import { ReviewController, ReviewOutcome } from "./review";
import { computeHunks, countChanges } from "./hunks";
import { ToolHost } from "./mcpServer";
import { resolvePath, toRelative, workspaceRoot } from "./workspace";

export type HostEvent =
  | { type: "context"; selection: Selection }
  | { type: "staged"; files: { path: string; added: number; removed: number; isNew: boolean }[] }
  | { type: "applied"; label: string; files: string[]; rejected: number; accepted: number }
  | { type: "reviewDiscarded"; reason: string }
  | { type: "command"; command: string; exitCode: number | null; output: string }
  | { type: "toolCall"; name: string; args: unknown };

export class AgentToolHost implements ToolHost {
  private readonly emitter = new vscode.EventEmitter<HostEvent>();
  readonly onEvent = this.emitter.event;
  pendingReview?: Promise<ReviewOutcome>;
  private running = new Set<ReturnType<typeof spawn>>();
  private readonly terminal: vscode.OutputChannel;

  constructor(
    readonly engine: ContextEngine,
    readonly changeset: Changeset,
    readonly review: ReviewController,
    readonly history: History,
  ) {
    this.terminal = vscode.window.createOutputChannel("ForgePilot Terminal");
    changeset.onDidChange(() => this.emitStaged());
  }

  private cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("forgepilot").get<T>(key, fallback);
  }

  onToolCall(name: string, args: unknown) {
    this.emitter.fire({ type: "toolCall", name, args });
  }

  private emitStaged() {
    const files = [...this.changeset.files.values()].map((f) => {
      const c = countChanges(computeHunks(f.original, f.proposed));
      return { path: f.path, added: c.added, removed: c.removed, isNew: !f.existed };
    });
    this.emitter.fire({ type: "staged", files });
  }

  async findRelevantCode(task: string, budget?: number, maxFiles?: number): Promise<string> {
    const b = budget ?? this.cfg("contextBudgetTokens", 6000);
    const selection = await this.engine.select(task, b, { maxFiles });
    this.emitter.fire({ type: "context", selection });
    return `${selection.rendered}\n\nNext step: if the request asks for a change, read_file the exact ranges you will modify, stage the changes with edit_file or write_file in every file the request needs, then call submit_changes. Do not stop at a summary.`;
  }

  repoMap(): Promise<string> {
    return this.engine.repoMap();
  }

  async listFiles(glob?: string, dir?: string): Promise<string> {
    const files = await this.engine.listFiles(glob, dir);
    if (!files.length) return "No files matched.";
    const shown = files.slice(0, 400);
    return `${files.length} files${files.length > shown.length ? ` (first ${shown.length})` : ""}:\n${shown.join("\n")}`;
  }

  async readFile(p: string, start?: number, end?: number): Promise<string> {
    const rel = toRelative(p);
    const cur = await this.changeset.readCurrent(rel);
    if (!cur) {
      const guesses = (await this.engine.listFiles(`**/${path.posix.basename(rel)}`)).slice(0, 5);
      throw new Error(`${rel} does not exist.${guesses.length ? ` Did you mean: ${guesses.join(", ")}?` : ""}`);
    }
    const lines = cur.text.replace(/\r\n/g, "\n").split("\n");
    const total = lines.length;
    const s = Math.max(1, start ?? 1);
    const maxSpan = 400;
    const e = Math.min(total, end ?? s + maxSpan - 1, s + maxSpan - 1);
    const width = String(e).length;
    const body = lines
      .slice(s - 1, e)
      .map((l, i) => `${String(s + i).padStart(width)}| ${l}`)
      .join("\n");
    const notes = [`${rel} (${total} lines${cur.staged ? ", includes your staged unapplied edits" : ""}) lines ${s}-${e}:`];
    const out = `${notes.join("")}\n${body}`;
    return e < total ? `${out}\n... ${total - e} more lines. Call read_file with start_line=${e + 1} to continue.` : out;
  }

  searchCode(query: string, regex?: boolean, glob?: string, max?: number): Promise<string> {
    return this.engine.search(query, { regex, glob, maxResults: max });
  }

  async findSymbol(name: string, includeBody?: boolean): Promise<string> {
    const locs = await this.engine.findSymbol(name);
    if (!locs.length) return `No definition named "${name}" exists in the workspace. Do not reference it unless you are creating it.`;
    const parts: string[] = [];
    for (const l of locs.slice(0, 12)) {
      parts.push(`${l.file}:${l.line} ${l.kind} ${l.qualified}: ${l.signature}`);
      if (includeBody && parts.length <= 3) parts.push(await this.engine.symbolBody(l, 80));
    }
    return parts.join("\n");
  }

  async editFile(p: string, edits: { old_text: string; new_text: string }[], reason?: string): Promise<string> {
    const file = await this.changeset.stageEdits(p, edits);
    return this.describeStaged(file.path, reason);
  }

  async writeFile(p: string, content: string, reason?: string): Promise<string> {
    const file = await this.changeset.stageWrite(p, content);
    return this.describeStaged(file.path, reason);
  }

  private describeStaged(rel: string, reason?: string): string {
    const f = this.changeset.files.get(rel)!;
    const hunks = computeHunks(f.original, f.proposed);
    const c = countChanges(hunks);
    const staged = [...this.changeset.files.keys()];
    const preview = hunks
      .slice(0, 6)
      .map((h) => `@@ line ${h.origStart + 1}\n${h.origLines.map((l) => "-" + l).join("\n")}${h.origLines.length ? "\n" : ""}${h.newLines.map((l) => "+" + l).join("\n")}`)
      .join("\n");
    return `Staged ${f.existed ? "edit to" : "new file"} ${rel}: ${hunks.length} hunk(s), +${c.added} -${c.removed} lines${reason ? ` (${reason})` : ""}. Not on disk yet.\nStaged files: ${staged.join(", ")}\n${preview}`;
  }

  async showStaged(): Promise<string> {
    if (this.changeset.isEmpty) return "Nothing is staged.";
    const parts: string[] = [];
    for (const f of this.changeset.files.values()) {
      parts.push(createTwoFilesPatch(`a/${f.path}`, `b/${f.path}`, f.existed ? f.original : "", f.proposed, "", "", { context: 2 }));
    }
    return parts.join("\n");
  }

  async discardStaged(p?: string): Promise<string> {
    if (p) return this.changeset.unstage(p) ? `Discarded staged edits to ${toRelative(p)}.` : `Nothing staged for ${p}.`;
    const n = this.changeset.discardAll();
    return `Discarded staged edits to ${n} file(s).`;
  }

  startReview(summary: string): Promise<ReviewOutcome> {
    if (this.pendingReview) return this.pendingReview;
    const files = [...this.changeset.files.values()]
      .map((file) => ({ file: { ...file }, hunks: computeHunks(file.original, file.proposed) }))
      .filter((f) => f.hunks.length);
    this.pendingReview = this.review.start(files, summary, true);
    return this.pendingReview;
  }

  async submitChanges(summary: string): Promise<string> {
    if (this.changeset.isEmpty) return "Nothing is staged, so there is nothing to submit. Stage edits with edit_file or write_file first.";
    const outcome = await this.startReview(summary);
    this.pendingReview = undefined;
    return this.finishReview(outcome, summary);
  }

  async finishReview(outcome: ReviewOutcome, summary: string): Promise<string> {
    const accepted = outcome.files.reduce((n, f) => n + f.hunks.filter((h) => h.state === "accepted").length, 0);
    const rejectedHunks = outcome.files.flatMap((f) => f.hunks.filter((h) => h.state !== "accepted").map((h) => ({ path: f.file.path, h })));
    if (outcome.decision === "discard" || accepted === 0) {
      this.changeset.discardAll();
      this.emitter.fire({ type: "reviewDiscarded", reason: "The user rejected every hunk." });
      return "The user rejected every hunk. Nothing was written to disk and the staged edits were cleared. Do not re-submit the same change; summarize what you proposed and stop unless the user asks for something else.";
    }
    const change = await applyReviewed(outcome.files, summary);
    this.history.push(change);
    this.changeset.discardAll();
    this.engine.invalidate();
    this.emitter.fire({
      type: "applied",
      label: summary,
      files: change.files.map((f) => f.path),
      accepted,
      rejected: rejectedHunks.length,
    });
    const rejectedText = rejectedHunks.length
      ? `\nRejected hunks (not written):\n${rejectedHunks
          .map(({ path: p, h }) => `${p} near line ${h.origStart + 1}:\n${h.newLines.slice(0, 12).map((l) => "+" + l).join("\n")}`)
          .join("\n")}`
      : "";
    return `Applied ${accepted} hunk(s) to ${change.files.map((f) => f.path).join(", ")}. The files on disk now contain these changes and the user can undo them as one step.${rejectedText}`;
  }

  async runCommand(command: string, timeoutSeconds?: number): Promise<string> {
    const allowed = this.cfg<string[]>("allowedCommands", []);
    const trimmed = command.trim();
    const ok = allowed.some((p) => trimmed === p || trimmed.toLowerCase().startsWith(p.toLowerCase() + " "));
    const dangerous = /[;&|`]|\$\(|>\s*\S/.test(trimmed.replace(/2>&1/g, ""));
    if (!ok || dangerous) {
      const choice = await vscode.window.showWarningMessage(`The agent wants to run:\n${trimmed}`, { modal: true }, "Run once");
      if (choice !== "Run once") return `The user declined to run: ${trimmed}`;
    }
    const root = workspaceRoot();
    const env = { ...process.env };
    for (const venv of [".venv", "venv", "env"]) {
      const bin = path.join(root, venv, process.platform === "win32" ? "Scripts" : "bin");
      if (fs.existsSync(bin)) {
        env.PATH = `${bin}${path.delimiter}${env.PATH ?? env.Path ?? ""}`;
        env.Path = env.PATH;
        env.VIRTUAL_ENV = path.join(root, venv);
        break;
      }
    }
    env.PYTHONIOENCODING = "utf-8";
    this.terminal.show(true);
    this.terminal.appendLine(`\n$ ${trimmed}`);
    return new Promise((resolve) => {
      const child = spawn(trimmed, { cwd: root, shell: true, env, windowsHide: true });
      this.running.add(child);
      let out = "";
      const onData = (d: Buffer) => {
        const s = d.toString("utf8");
        out += s;
        this.terminal.append(s);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => {
        out += `\n[timed out after ${timeoutSeconds ?? 120}s]`;
        killTree(child);
      }, (timeoutSeconds ?? 120) * 1000);
      child.on("close", (code) => {
        clearTimeout(timer);
        this.running.delete(child);
        this.terminal.appendLine(`[exit ${code}]`);
        const clipped = out.length > 12000 ? `${out.slice(0, 4000)}\n...[${out.length - 10000} chars omitted]...\n${out.slice(-6000)}` : out;
        this.emitter.fire({ type: "command", command: trimmed, exitCode: code, output: clipped.slice(-1500) });
        resolve(`$ ${trimmed}\nexit code: ${code}\n${clipped}`);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        this.running.delete(child);
        resolve(`Failed to start: ${err.message}`);
      });
    });
  }

  cancelAll() {
    for (const c of this.running) killTree(c);
    this.running.clear();
    this.review.cancel();
    this.pendingReview = undefined;
    this.changeset.discardAll();
  }
}

function killTree(child: ReturnType<typeof spawn>) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  else child.kill("SIGTERM");
}

export function resolveForMention(engine: ContextEngine, token: string): string | undefined {
  try {
    resolvePath(token);
  } catch {
    return undefined;
  }
  const rel = toRelative(token);
  if (engine.hasFile(rel)) return rel;
  const matches = engine.allPaths().filter((p) => p.endsWith("/" + rel) || path.posix.basename(p) === rel);
  return matches.length === 1 ? matches[0] : undefined;
}
