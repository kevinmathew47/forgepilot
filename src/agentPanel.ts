import * as vscode from "vscode";
import { Services, MCP_SERVER_NAME } from "./services";
import { AnyEvent, PendingCall } from "./forge";
import { runWithFallback } from "./fallback";
import { HostEvent, resolveForMention } from "./agentTools";
import { estimateTokens } from "./contextEngine";
import { toRelative } from "./workspace";
import { InlineEvent } from "./inlineEdit";

type ToWebview = Record<string, any> & { type: string };

export class AgentPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private queue: ToWebview[] = [];
  private sessionId?: string;
  private sessionModel?: string;
  private callNames = new Map<string, { name: string; args: any; thread: string }>();
  private threadTitles = new Map<string, string>();
  private announced = new Set<string>();

  constructor(private readonly svc: Services) {
    svc.host.onEvent((e) => this.onHostEvent(e));
    svc.review.onDidChangeState((s) => this.post({ type: "review", review: s ?? null }));
    svc.history.onDidChange(() => this.post({ type: "history", size: svc.history.size, last: svc.history.last?.label ?? null }));
    svc.onModelsChanged((order) => this.post({ type: "models", order, available: svc.available, connected: svc.connected }));
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.svc.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="${css}" rel="stylesheet"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  post(msg: ToWebview) {
    if (this.view) void this.view.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  private flush() {
    const q = this.queue.splice(0);
    for (const m of q) this.post(m);
  }

  inline(e: InlineEvent) {
    this.post({ type: "notice", level: e.phase === "error" ? "error" : e.phase === "fallback" || e.phase === "retry" ? "warn" : "info", text: `Inline edit · ${e.text}` });
  }

  private async onMessage(m: any) {
    switch (m.type) {
      case "ready":
        this.flush();
        await this.svc.refreshModels();
        this.post({ type: "models", order: this.svc.modelOrder(), available: this.svc.available, connected: this.svc.connected });
        this.post({ type: "review", review: this.svc.review.summary() ?? null });
        this.post({ type: "history", size: this.svc.history.size, last: this.svc.history.last?.label ?? null });
        break;
      case "send":
        await this.send(String(m.text ?? ""));
        break;
      case "stop":
        await this.svc.cancelActive();
        break;
      case "hunk":
        this.svc.review.setHunk(m.path, m.id, m.state);
        break;
      case "acceptAll":
        this.svc.review.decideAll("accepted");
        break;
      case "rejectAll":
        this.svc.review.decideAll("rejected");
        break;
      case "apply":
        await this.svc.review.applyCurrent();
        break;
      case "openReviewFile":
        await vscode.commands.executeCommand("forgepilot.openReviewFile", m.path);
        break;
      case "openFile":
        try {
          const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, m.path);
          const ed = await vscode.window.showTextDocument(uri, { preview: true });
          if (m.line) {
            const pos = new vscode.Position(Math.max(0, m.line - 1), 0);
            ed.selection = new vscode.Selection(pos, pos);
            ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
        } catch {
          return;
        }
        break;
      case "openSession":
        if (this.sessionId) await vscode.env.openExternal(vscode.Uri.parse(this.svc.forge.sessionUrl(this.sessionId)));
        break;
      case "undo":
        await vscode.commands.executeCommand("forgepilot.undoLast");
        break;
      case "newChat":
        if (this.svc.activeRun) await this.svc.cancelActive();
        this.sessionId = undefined;
        this.sessionModel = undefined;
        this.post({ type: "reset" });
        break;
      case "pickModels":
        await vscode.commands.executeCommand("forgepilot.selectModels");
        break;
      case "reconnect":
        await vscode.commands.executeCommand("forgepilot.reconnect");
        break;
      case "complete":
        this.post({ type: "completions", items: await this.complete(String(m.q ?? "")) });
        break;
    }
  }

  private async complete(q: string) {
    await this.svc.engine.ensure();
    const lower = q.toLowerCase();
    const files = this.svc.engine
      .allPaths()
      .filter((p) => p.toLowerCase().includes(lower))
      .sort((a, b) => a.length - b.length)
      .slice(0, 8)
      .map((p) => ({ label: p, kind: "file" }));
    const syms = q.length >= 2 ? (await this.svc.engine.findSymbol(q)).filter((s) => s.kind !== "section" && s.kind !== "variable").slice(0, 8) : [];
    return [...files, ...syms.map((s) => ({ label: s.name, kind: s.kind, detail: `${s.file}:${s.line}` }))];
  }

  private async resolveMentions(text: string) {
    const blocks: string[] = [];
    const attached: { label: string; kind: string; tokens: number }[] = [];
    let used = 0;
    const budget = 12000;
    for (const m of text.match(/(^|\s)@[\w./\\-]+/g) ?? []) {
      const token = m.trim().slice(1);
      const file = resolveForMention(this.svc.engine, token);
      if (file) {
        const cur = await this.svc.changeset.readCurrent(file);
        const lines = (cur?.text ?? "").split(/\r?\n/);
        const body = lines
          .slice(0, 400)
          .map((l, i) => `${i + 1}| ${l}`)
          .join("\n");
        const block = `### @${file}${lines.length > 400 ? ` (first 400 of ${lines.length} lines)` : ""}\n${body}`;
        const cost = estimateTokens(block);
        if (used + cost > budget) continue;
        used += cost;
        blocks.push(block);
        attached.push({ label: file, kind: "file", tokens: cost });
        continue;
      }
      const locs = (await this.svc.engine.findSymbol(token)).filter((l) => l.name === token || l.qualified === token);
      for (const loc of locs.slice(0, 2)) {
        const block = `### @${loc.qualified} (${loc.kind} in ${loc.file}:${loc.line})\n${await this.svc.engine.symbolBody(loc, 120)}`;
        const cost = estimateTokens(block);
        if (used + cost > budget) continue;
        used += cost;
        blocks.push(block);
        attached.push({ label: `${loc.qualified} · ${loc.file}:${loc.line}`, kind: "symbol", tokens: cost });
      }
    }
    return { blocks, attached, used };
  }

  private ideContext(): string {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== "file") return "";
    let rel: string;
    try {
      rel = toRelative(ed.document.uri.fsPath);
    } catch {
      return "";
    }
    const sel = ed.selection;
    return `The user currently has ${rel} open${sel.isEmpty ? ` (cursor at line ${sel.active.line + 1})` : ` with lines ${sel.start.line + 1}-${sel.end.line + 1} selected`}. This is background only; it does not mean the change belongs there.`;
  }

  async send(text: string) {
    if (!text.trim()) return;
    if (this.svc.activeRun) {
      vscode.window.showWarningMessage("ForgePilot is already running. Stop it first.");
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      this.post({ type: "notice", level: "error", text: "Open a folder first." });
      return;
    }
    await this.svc.engine.ensure();
    try {
      await this.svc.forge.registerMcpServer(MCP_SERVER_NAME, this.svc.mcp.url, this.svc.mcp.token);
    } catch (e) {
      this.post({ type: "notice", level: "error", text: `Could not register the editor tools with TrueForge at ${this.svc.forge.baseUrl}: ${(e as Error).message}\nIs TrueForge running? Start it with scripts/start-trueforge, then try again.` });
      return;
    }
    const mentions = await this.resolveMentions(text);
    this.post({ type: "user", text, attachments: mentions.attached });
    const ide = this.ideContext();
    const message = [
      text,
      mentions.blocks.length ? `\n\nContext the user attached explicitly (${mentions.used} tokens):\n${mentions.blocks.join("\n\n")}` : "",
      ide ? `\n\n[${ide}]` : "",
    ].join("");

    const controller = new AbortController();
    const host = this.svc.host;
    const historyBefore = this.svc.history.size;
    let currentSession: string | undefined;
    this.svc.activeRun = {
      kind: "agent",
      abort: async () => {
        controller.abort();
        if (currentSession) await this.svc.forge.cancel(currentSession);
        host.cancelAll();
      },
    };
    this.post({ type: "running", running: true });
    this.callNames.clear();
    this.announced.clear();

    const order = this.svc.modelOrder();
    if (this.sessionModel && order.includes(this.sessionModel)) {
      order.splice(order.indexOf(this.sessionModel), 1);
      order.unshift(this.sessionModel);
    }
    try {
      const result = await runWithFallback(
        order,
        this.svc.cfg("retryAttempts", 2),
        controller.signal,
        (n) => {
          if (n.type === "attempt") {
            this.svc.showRunning(`ForgePilot agent · ${n.model}`);
            this.post({ type: "modelActive", model: n.model, attempt: n.attempt });
          } else if (n.type === "retry") {
            this.post({ type: "notice", level: "warn", text: `${n.model} failed: ${n.message}\nRetrying in ${(n.delayMs / 1000).toFixed(1)}s (attempt ${n.attempt + 1}).` });
          } else if (n.type === "fallback") {
            this.post({ type: "notice", level: "warn", text: `${n.from} failed: ${n.message}\nFalling back to ${n.to} automatically.` });
          }
        },
        async (model, attemptNo) => {
          const resume = attemptNo > 0 && !!this.sessionId && this.sessionModel === model;
          if (!resume && (host.changeset.files.size || this.svc.review.active)) {
            host.cancelAll();
            this.post({ type: "notice", level: "info", text: "Discarded the failed attempt's staged edits; the workspace was not changed." });
          }
          if (resume) {
            currentSession = this.sessionId;
            this.post({ type: "notice", level: "info", text: `Resuming the same TrueForge session on ${model}; ${host.changeset.files.size} staged file(s) kept.` });
            const handlersResume = {
              onEvent: (ev: AnyEvent, merged: AnyEvent | undefined) => this.onForgeEvent(ev, merged),
              onPause: (calls: PendingCall[]) => this.onPause(calls),
            };
            const staged = [...host.changeset.files.keys()];
            return this.svc.forge.runTurn(
              this.sessionId!,
              `The previous model request failed with a temporary error. Continue the original task from where you stopped. ${staged.length ? `Your staged edits to ${staged.join(", ")} are still staged; do not redo them.` : ""} Finish every remaining part of the request, then call submit_changes.`,
              controller.signal,
              handlersResume,
            );
          }
          if (!this.sessionId || this.sessionModel !== model) {
            try {
              this.sessionId = await this.svc.forge.createSession(this.svc.spec("forgepilot-coder", model), text.slice(0, 80));
              this.sessionModel = model;
            } catch (e) {
              return { status: "error", message: (e as Error).message };
            }
            this.post({ type: "session", id: this.sessionId, url: this.svc.forge.sessionUrl(this.sessionId), model });
          }
          currentSession = this.sessionId;
          const handlers = {
            onEvent: (ev: AnyEvent, merged: AnyEvent | undefined) => this.onForgeEvent(ev, merged),
            onPause: (calls: PendingCall[]) => this.onPause(calls),
          };
          let r = await this.svc.forge.runTurn(this.sessionId, message, controller.signal, handlers);
          const wantsChange = /\b(add|implement|create|fix|change|update|remove|delete|rename|refactor|write|make|support|replace|extend|document)\b/i.test(text);
          for (let nudge = 0; nudge < 3 && r.status === "done" && !controller.signal.aborted; nudge++) {
            const staged = !host.changeset.isEmpty;
            const appliedNow = this.svc.history.size - historyBefore;
            let follow: string | undefined;
            if (staged) {
              follow = "Your edits are staged but not submitted. Call submit_changes now with a one-sentence summary so the user can review them.";
            } else if (wantsChange && appliedNow === 0) {
              follow =
                "You have not changed any files yet, and the request requires code changes. Continue the task now: read_file the exact line ranges you need, stage the edits with edit_file (or write_file for new files) in every file the request needs, including tests and documentation if the request mentions them, then call submit_changes. Do not reply with only a summary.";
            }
            if (!follow) break;
            this.post({ type: "notice", level: "info", text: `ForgePilot: the model stopped before finishing (${staged ? "edits not submitted" : "no edits yet"}); sending an automatic follow-up turn in the same TrueForge session.` });
            r = await this.svc.forge.runTurn(this.sessionId, follow, controller.signal, handlers);
          }
          return r;
        },
      );
      const applied = this.svc.history.size - historyBefore;
      if (result.status === "done") {
        this.post({ type: "final", text: result.output ?? "", metrics: result.metrics ?? null, model: result.model });
      } else if (result.status === "cancelled") {
        host.cancelAll();
        this.post({
          type: "notice",
          level: "warn",
          text: `Cancelled. Staged edits were discarded${applied ? `; ${applied} change set(s) you had already approved stay applied (use Undo to revert)` : " and no file was changed"}.`,
        });
      } else {
        host.cancelAll();
        this.post({ type: "notice", level: "error", text: `${result.message ?? "The run failed."}\n${applied ? "Changes you approved earlier stay applied." : "No file was changed."}` });
      }
    } finally {
      this.svc.activeRun = undefined;
      this.svc.hideRunning();
      this.post({ type: "running", running: false });
    }
  }

  private onForgeEvent(ev: AnyEvent, merged: AnyEvent | undefined) {
    const thread = ev.threadId ?? "main";
    switch (ev.type) {
      case "model.message":
        this.post({ type: "msgStart", id: ev.id, thread, threadTitle: this.threadTitles.get(thread) });
        if (ev.content) this.post({ type: "delta", id: ev.id, thread, content: ev.content });
        this.trackCalls(ev, thread);
        break;
      case "model.message.delta":
        if (typeof ev.content === "string" && ev.content) this.post({ type: "delta", id: ev.id, thread, content: ev.content });
        if (merged) this.trackCalls(merged, thread);
        break;
      case "tool.response": {
        const call = this.callNames.get(ev.toolCallId);
        const content = typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content);
        this.post({ type: "toolResult", callId: ev.toolCallId, name: call?.name ?? "tool", thread, content: content.slice(0, 1600), isError: /^Error:/.test(content) });
        break;
      }
      case "thread.created":
        this.threadTitles.set(ev.threadId, ev.title ?? "subagent");
        this.post({ type: "thread", thread: ev.threadId, title: ev.title ?? "subagent", task: ev.agentInfo?.input ?? "" });
        break;
      case "thread.done":
        this.post({ type: "threadDone", thread: ev.threadId, status: ev.state?.status ?? "done" });
        break;
      case "thread.context_compaction.started":
      case "thread.context_compaction_started":
        this.post({ type: "notice", level: "info", text: `TrueForge is compacting the ${thread === "main" ? "agent" : "subagent"} context to stay within the model window.` });
        break;
      case "thread.context_compaction.finished":
      case "thread.context_compaction_finished":
        this.post({ type: "notice", level: "info", text: "Context compaction finished." });
        break;
      case "mcp.initialize":
        this.post({ type: "mcp", servers: (ev.mcpServers ?? []).map((s: any) => s.name) });
        break;
      case "turn.update":
        this.post({ type: "turnState", status: ev.state?.status });
        break;
      default:
        if (/compaction/.test(ev.type)) this.post({ type: "notice", level: "info", text: `TrueForge: ${ev.type}` });
    }
  }

  private trackCalls(msg: AnyEvent, thread: string) {
    if (!msg.finishReason || !msg.toolCalls?.length) return;
    for (const tc of msg.toolCalls) {
      if (!tc.id || this.announced.has(tc.id)) continue;
      let args: any = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        args = { raw: tc.function?.arguments };
      }
      let name = tc.toolInfo?.name ?? tc.function?.name ?? "tool";
      if (name === "call_tool" && args.tool_name) {
        name = `${args.tool_name} (deferred)`;
        args = args.arguments ?? args;
      }
      this.announced.add(tc.id);
      this.callNames.set(tc.id, { name, args, thread });
      this.post({ type: "toolCall", callId: tc.id, name, args: summarizeArgs(args), thread, threadTitle: this.threadTitles.get(thread) });
    }
  }

  private async onPause(calls: PendingCall[]): Promise<AnyEvent[]> {
    const answers: AnyEvent[] = [];
    for (const call of calls) {
      if (call.kind === "approval" && call.name === "submit_changes") {
        const summary = String(call.args.summary ?? "Agent changes");
        if (this.svc.changeset.isEmpty) {
          answers.push({ type: "user.tool_approval", threadId: call.threadId, toolCallId: call.id, approval: { status: "allow" } } as any);
          continue;
        }
        this.post({ type: "notice", level: "info", text: `TrueForge paused for approval of submit_changes. Review each hunk (diff tabs or below); accepted hunks are written as one undoable change.` });
        this.svc.hideRunning();
        const outcome = await this.svc.host.startReview(summary);
        const accepted = outcome.files.reduce((n, f) => n + f.hunks.filter((h) => h.state === "accepted").length, 0);
        if (outcome.decision === "apply" && accepted > 0) {
          answers.push({ type: "user.tool_approval", threadId: call.threadId, toolCallId: call.id, approval: { status: "allow" } } as any);
        } else {
          this.svc.host.pendingReview = undefined;
          await this.svc.host.finishReview(outcome, summary);
          answers.push({
            type: "user.tool_approval",
            threadId: call.threadId,
            toolCallId: call.id,
            approval: { status: "deny", reason: "The user rejected every hunk. Nothing was written and the staged edits were cleared." },
          } as any);
        }
        this.svc.showRunning(`ForgePilot agent · ${this.sessionModel ?? ""}`);
      } else if (call.kind === "approval") {
        const choice = await vscode.window.showWarningMessage(
          `The agent wants to call ${call.name}${call.server ? ` on ${call.server}` : ""} with ${JSON.stringify(call.args).slice(0, 300)}`,
          { modal: true },
          "Allow",
        );
        answers.push({
          type: "user.tool_approval",
          threadId: call.threadId,
          toolCallId: call.id,
          approval: choice === "Allow" ? { status: "allow" } : { status: "deny", reason: "Denied by the user." },
        } as any);
      } else {
        const reply = await vscode.window.showInputBox({ title: "ForgePilot agent asks", prompt: String(call.args.question ?? "The agent needs input"), ignoreFocusOut: true });
        answers.push({ type: "user.tool_response", threadId: call.threadId, toolCallId: call.id, content: reply?.trim() || "No answer; use your best judgement." } as any);
      }
    }
    return answers;
  }

  private onHostEvent(e: HostEvent) {
    switch (e.type) {
      case "context":
        this.post({
          type: "context",
          query: e.selection.query,
          budget: e.selection.budget,
          used: e.selection.used,
          considered: e.selection.considered,
          files: e.selection.files.map((f) => ({ path: f.path, role: f.role, score: f.score, tokens: f.tokens, reasons: f.reasons, chunks: f.chunks })),
          omitted: e.selection.omitted.slice(0, 5),
        });
        break;
      case "staged":
        this.post({ type: "staged", files: e.files });
        break;
      case "applied":
        this.post({ type: "applied", label: e.label, files: e.files, accepted: e.accepted, rejected: e.rejected });
        break;
      case "reviewDiscarded":
        this.post({ type: "notice", level: "warn", text: `Review closed: ${e.reason} Nothing was written.` });
        break;
      case "command":
        this.post({ type: "command", command: e.command, exitCode: e.exitCode, output: e.output });
        break;
    }
  }
}

function summarizeArgs(args: any): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === "edits" && Array.isArray(v)) parts.push(`${v.length} edit(s)`);
    else if (k === "content" && typeof v === "string") parts.push(`${v.split("\n").length} lines`);
    else parts.push(`${k}=${typeof v === "string" ? JSON.stringify(v.length > 90 ? v.slice(0, 90) + "…" : v) : JSON.stringify(v)}`);
  }
  return parts.join("  ");
}
