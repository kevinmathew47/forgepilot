import * as vscode from "vscode";
import { Services } from "./services";
import { runWithFallback } from "./fallback";
import { applyReviewed, StagedFile } from "./changeset";
import { toRelative } from "./workspace";
import { estimateTokens } from "./contextEngine";
import { resolveForMention } from "./agentTools";

export interface InlineEvent {
  type: "inline";
  phase: "start" | "model" | "retry" | "fallback" | "done" | "applied" | "rejected" | "cancelled" | "error";
  text: string;
}

function extractCode(raw: string, final: boolean): string {
  const open = raw.match(/```[\w+-]*[ \t]*\r?\n/);
  let body: string;
  if (open && open.index !== undefined) {
    body = raw.slice(open.index + open[0].length);
    const close = body.search(/\r?\n?```/);
    if (close >= 0) body = body.slice(0, close);
    else if (!final) body = body.replace(/\n[^\n]*$/, (m) => (m.includes("`") ? "" : m));
  } else {
    if (!final && raw.trimStart().startsWith("`")) return "";
    body = raw.replace(/^\s*```.*$/m, "");
  }
  return body.replace(/\s+$/, "");
}

function reindent(code: string, baseIndent: string): string {
  const lines = code.split("\n");
  const nonEmpty = lines.filter((l) => l.trim());
  if (!nonEmpty.length) return code;
  const firstIndent = nonEmpty[0].match(/^\s*/)![0];
  if (firstIndent === baseIndent) return code;
  if (firstIndent.length > baseIndent.length) {
    const extra = firstIndent.slice(baseIndent.length);
    if (nonEmpty.every((l) => l.startsWith(firstIndent) || l.startsWith(baseIndent + extra.slice(0, 0)))) {
      return lines.map((l) => (l.startsWith(firstIndent) ? baseIndent + l.slice(firstIndent.length) : l)).join("\n");
    }
    return code;
  }
  return lines
    .map((l) => {
      if (!l.trim()) return l;
      return l.startsWith(firstIndent) ? baseIndent + l.slice(firstIndent.length) : baseIndent + l.trimStart();
    })
    .join("\n");
}

function importsBlock(lines: string[]): string {
  return lines
    .filter((l) => /^(from\s+\S+\s+import|import\s+\S+|#include|using\s+|require\(|const .* = require\()/.test(l.trim()) && !/^\s/.test(l))
    .slice(0, 40)
    .join("\n");
}

export interface InlineArgs {
  instruction?: string;
  startLine?: number;
  endLine?: number;
}

export async function runInlineEdit(svc: Services, emit: (e: InlineEvent) => void, args?: InlineArgs) {
  const editor = vscode.window.activeTextEditor;
  if (editor && args?.startLine !== undefined && args.endLine !== undefined) {
    editor.selection = new vscode.Selection(args.startLine - 1, 0, args.endLine - 1, editor.document.lineAt(args.endLine - 1).text.length);
  }
  if (!editor) {
    vscode.window.showInformationMessage("ForgePilot: open a file and select code first.");
    return;
  }
  if (svc.activeRun) {
    vscode.window.showWarningMessage("ForgePilot is already running. Cancel it first (Ctrl+Alt+X).");
    return;
  }
  const doc = editor.document;
  let sel = editor.selection;
  if (sel.isEmpty) {
    const symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", doc.uri)) ?? [];
    const flat: vscode.DocumentSymbol[] = [];
    const walk = (s: vscode.DocumentSymbol[]) => s.forEach((x) => (flat.push(x), walk(x.children)));
    walk(symbols);
    const inner = flat.filter((s) => s.range.contains(sel.active)).sort((a, b) => a.range.end.line - a.range.start.line - (b.range.end.line - b.range.start.line))[0];
    sel = inner ? new vscode.Selection(inner.range.start, inner.range.end) : new vscode.Selection(sel.active.line, 0, sel.active.line, doc.lineAt(sel.active.line).text.length);
  }
  const startLine = sel.start.line;
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
  editor.selection = new vscode.Selection(range.start, range.end);

  const instruction = args?.instruction ?? await vscode.window.showInputBox({
    title: "ForgePilot inline edit",
    prompt: `Edit lines ${startLine + 1}-${endLine + 1} of ${toRelative(doc.uri.fsPath)}. Use @file or @symbol to add context.`,
    placeHolder: "e.g. handle None input and update the docstring",
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;

  const fullText = doc.getText();
  const startOffset = doc.offsetAt(range.start);
  const endOffset = doc.offsetAt(range.end);
  const before = fullText.slice(0, startOffset);
  const after = fullText.slice(endOffset);
  const selected = fullText.slice(startOffset, endOffset);
  const baseIndent = (selected.split(/\r?\n/).find((l) => l.trim()) ?? "").match(/^\s*/)![0];
  const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const rel = toRelative(doc.uri.fsPath);
  const lines = fullText.split(/\r?\n/);

  await svc.engine.ensure();
  const budget = Math.min(3000, svc.cfg("contextBudgetTokens", 6000));
  const ctxParts: string[] = [];
  const ctxNames: string[] = [];
  let used = 0;
  const push = (label: string, body: string) => {
    if (!body.trim()) return;
    const block = `### ${label}\n${body}\n`;
    const cost = estimateTokens(block);
    if (used + cost > budget) return;
    used += cost;
    ctxParts.push(block);
    ctxNames.push(label);
  };
  for (const m of instruction.match(/@[\w./\\-]+/g) ?? []) {
    const token = m.slice(1);
    const file = resolveForMention(svc.engine, token);
    if (file) {
      const text = (await svc.changeset.readCurrent(file))?.text ?? "";
      push(`@${file}`, text.split(/\r?\n/).slice(0, 200).join("\n"));
      continue;
    }
    const locs = await svc.engine.findSymbol(token);
    if (locs[0]) push(`@${locs[0].qualified} (${locs[0].file})`, await svc.engine.symbolBody(locs[0], 60));
  }
  push(`imports of ${rel}`, importsBlock(lines));
  const aboveFrom = Math.max(0, startLine - 25);
  push(`${rel} lines ${aboveFrom + 1}-${startLine} (above the selection)`, lines.slice(aboveFrom, startLine).join("\n"));
  push(`${rel} lines ${endLine + 2}-${Math.min(lines.length, endLine + 16)} (below the selection)`, lines.slice(endLine + 1, endLine + 16).join("\n"));
  const ids = await svc.engine.identifiersContext(selected + " " + instruction, rel, Math.max(0, budget - used));
  if (ids.rendered) push("definitions referenced by the selection", ids.rendered);

  const prompt = [
    `File: ${rel} (${doc.languageId})`,
    `Selected region: lines ${startLine + 1}-${endLine + 1}`,
    "",
    "Context (read-only):",
    ctxParts.join("\n"),
    "Selected region to rewrite:",
    "```" + doc.languageId,
    selected,
    "```",
    "",
    `Instruction: ${instruction.trim()}`,
    "",
    "Reply with one fenced code block containing the full replacement for the selected region.",
  ].join("\n");

  const file: StagedFile = { path: rel, uri: doc.uri, original: fullText, proposed: fullText, existed: true };
  const handle = await svc.review.startStreaming(file, `Inline edit: ${instruction.trim().slice(0, 60)}`);
  const controller = new AbortController();
  let sessionId: string | undefined;
  let modelInUse = "";
  const compose = (code: string) => before + reindent(code, baseIndent).replace(/\r?\n/g, eol) + after;

  svc.activeRun = {
    kind: "inline",
    abort: async () => {
      controller.abort();
      if (sessionId) await svc.forge.cancel(sessionId);
      handle.abort();
    },
  };
  emit({ type: "inline", phase: "start", text: `Inline edit on ${rel}:${startLine + 1}-${endLine + 1}: "${instruction.trim()}" · context: ${ctxNames.length} blocks, ~${used} tokens (${ctxNames.join("; ")})` });

  let raw = "";
  try {
    const result = await runWithFallback(
      svc.modelOrder(),
      svc.cfg("retryAttempts", 2),
      controller.signal,
      (n) => {
        if (n.type === "attempt") {
          modelInUse = n.model;
          svc.showRunning(`ForgePilot inline edit · ${n.model}`);
          emit({ type: "inline", phase: "model", text: `Generating with ${n.model} (attempt ${n.attempt})` });
        } else if (n.type === "retry") {
          emit({ type: "inline", phase: "retry", text: `${n.model} failed: ${n.message}. Retrying in ${(n.delayMs / 1000).toFixed(1)}s.` });
          svc.showRunning(`ForgePilot: retrying ${n.model} in ${(n.delayMs / 1000).toFixed(1)}s`);
        } else if (n.type === "fallback") {
          emit({ type: "inline", phase: "fallback", text: `${n.from} failed (${n.message}). Falling back to ${n.to} automatically.` });
          vscode.window.setStatusBarMessage(`$(arrow-swap) ForgePilot: ${n.from} failed, switched to ${n.to}`, 8000);
        }
      },
      async (model) => {
        raw = "";
        handle.update(fullText);
        try {
          sessionId = await svc.forge.createSession(svc.spec("forgepilot-inline", model), `Inline edit ${rel}`);
        } catch (e) {
          return { status: "error", message: (e as Error).message };
        }
        return svc.forge.runTurn(sessionId, prompt, controller.signal, {
          onEvent: (ev) => {
            if (ev.type === "model.message.delta" && (ev.threadId ?? "main") === "main" && typeof ev.content === "string") {
              raw += ev.content;
              const code = extractCode(raw, false);
              if (code) handle.update(compose(code));
            }
          },
        });
      },
    );

    if (result.status === "cancelled" || controller.signal.aborted) {
      handle.abort();
      emit({ type: "inline", phase: "cancelled", text: "Inline edit cancelled. No file was changed." });
      vscode.window.setStatusBarMessage("$(circle-slash) ForgePilot: inline edit cancelled, nothing changed", 6000);
      return;
    }
    if (result.status === "error") {
      handle.abort();
      emit({ type: "inline", phase: "error", text: result.message ?? "Inline edit failed." });
      vscode.window.showErrorMessage(`ForgePilot inline edit failed. No file was changed.\n${result.message}`, "Open log").then((c) => {
        if (c) svc.log.show();
      });
      return;
    }
    const finalRaw = raw || result.output || "";
    const code = extractCode(finalRaw, true);
    if (!code.trim()) {
      handle.abort();
      emit({ type: "inline", phase: "error", text: `${modelInUse} returned no code. No file was changed.` });
      vscode.window.showWarningMessage("ForgePilot: the model returned no code. No file was changed.");
      return;
    }
    svc.hideRunning();
    emit({ type: "inline", phase: "done", text: `Proposal ready from ${modelInUse}. Accept or reject each hunk in the diff.` });
    const outcome = await handle.complete(compose(code));
    if (outcome.decision !== "apply") {
      emit({ type: "inline", phase: "rejected", text: "All hunks rejected. No file was changed." });
      vscode.window.setStatusBarMessage("$(circle-slash) ForgePilot: proposal rejected, nothing changed", 6000);
      return;
    }
    const change = await applyReviewed(outcome.files, `Inline edit: ${instruction.trim()}`);
    if (change.files.length) svc.history.push(change);
    svc.engine.invalidate();
    const accepted = outcome.files[0].hunks.filter((h) => h.state === "accepted").length;
    const total = outcome.files[0].hunks.length;
    emit({ type: "inline", phase: "applied", text: `Applied ${accepted}/${total} hunks to ${rel}.` });
    await vscode.window.showTextDocument(doc.uri, { preview: false });
    vscode.window
      .showInformationMessage(`ForgePilot applied ${accepted}/${total} hunk(s) to ${rel}.`, "Undo")
      .then((c) => c === "Undo" && vscode.commands.executeCommand("forgepilot.undoLast"));
  } catch (e) {
    handle.abort();
    const msg = (e as Error).message;
    emit({ type: "inline", phase: "error", text: msg });
    vscode.window.showErrorMessage(`ForgePilot: ${msg}`);
  } finally {
    svc.activeRun = undefined;
    svc.hideRunning();
  }
}
