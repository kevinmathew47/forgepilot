import * as vscode from "vscode";
import { Services, MCP_SERVER_NAME } from "./services";
import { ContextEngine } from "./contextEngine";
import { AgentToolHost } from "./agentTools";
import { EditorMcpServer } from "./mcpServer";
import { AgentPanel } from "./agentPanel";
import { InlineArgs, runInlineEdit } from "./inlineEdit";

let services: Services | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const svc = new Services(context);
  services = svc;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  svc.engine = new ContextEngine(root);
  svc.host = new AgentToolHost(svc.engine, svc.changeset, svc.review, svc.history);
  svc.mcp = new EditorMcpServer(svc.host);
  svc.review.register(context);

  const conn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  conn.command = "forgepilot.reconnect";
  context.subscriptions.push(conn);
  const renderConn = () => {
    const order = svc.modelOrder();
    conn.text = svc.connected ? `$(plug) TrueForge · ${order.map((m) => m.split("/").pop()).join(" → ") || "no model"}` : "$(debug-disconnect) TrueForge offline";
    conn.tooltip = svc.connected
      ? `ForgePilot is connected to ${svc.forge.baseUrl}.\nModel order (primary first, then automatic fallbacks):\n${order.join("\n")}\nEditor MCP server: ${svc.mcp.url}`
      : `ForgePilot cannot reach TrueForge at ${svc.forge.baseUrl}. Start it with scripts/start-trueforge, then click to reconnect.`;
    conn.show();
  };
  svc.onModelsChanged(renderConn);

  const panel = new AgentPanel(svc);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("forgepilot.agent", panel, { webviewOptions: { retainContextWhenHidden: true } }));

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidChange(() => svc.engine.invalidate());
  watcher.onDidCreate(() => svc.engine.invalidate());
  watcher.onDidDelete(() => svc.engine.invalidate());
  context.subscriptions.push(watcher, vscode.workspace.onDidSaveTextDocument(() => svc.engine.invalidate()));

  const connect = async (announce: boolean) => {
    svc.forge.setBaseUrl(svc.cfg("trueforgeUrl", "http://localhost:8790"));
    if (!svc.mcp.port) {
      const port = await svc.mcp.start(svc.cfg("mcpPort", 8791));
      svc.log.appendLine(`Editor MCP server listening on ${svc.mcp.url} (port ${port})`);
    }
    const ok = await svc.forge.ping();
    if (!ok) {
      svc.connected = false;
      renderConn();
      svc.log.appendLine(`TrueForge not reachable at ${svc.forge.baseUrl}`);
      if (announce) {
        vscode.window.showWarningMessage(`ForgePilot cannot reach TrueForge at ${svc.forge.baseUrl}. Start it with scripts/start-trueforge, then run "ForgePilot: Reconnect".`, "Reconnect").then((c) => c && connect(true));
      }
      return;
    }
    try {
      await svc.forge.registerMcpServer(MCP_SERVER_NAME, svc.mcp.url, svc.mcp.token);
      svc.log.appendLine(`Registered MCP server ${MCP_SERVER_NAME} -> ${svc.mcp.url} in TrueForge`);
    } catch (e) {
      svc.log.appendLine(`Could not register MCP server: ${(e as Error).message}`);
      vscode.window.showErrorMessage(`ForgePilot could not register its MCP server in TrueForge: ${(e as Error).message}`);
    }
    await svc.refreshModels();
    const primary = svc.modelOrder()[0];
    if (primary) {
      for (const name of ["forgepilot-coder", "forgepilot-inline"] as const) {
        try {
          const def = svc.definition(name);
          await svc.forge.upsertAgent(def.name, svc.spec(name, primary), def.description);
        } catch (e) {
          svc.log.appendLine(`Could not save agent ${name}: ${(e as Error).message}`);
        }
      }
    }
    renderConn();
    if (announce) vscode.window.setStatusBarMessage(`$(plug) ForgePilot connected to TrueForge (${svc.available.length} model(s))`, 5000);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("forgepilot.inlineEdit", (args?: InlineArgs) => runInlineEdit(svc, (e) => panel.inline(e), args && typeof args === "object" && "instruction" in args ? args : undefined)),
    vscode.commands.registerCommand("forgepilot.runAgent", async (text?: string) => {
      const prompt = text ?? (await vscode.window.showInputBox({ title: "ForgePilot agent", prompt: "Describe the change", ignoreFocusOut: true }));
      if (prompt) await panel.send(prompt);
    }),
    vscode.commands.registerCommand("forgepilot._state", () => ({
      reviewActive: svc.review.active,
      review: svc.review.summary(),
      historySize: svc.history.size,
      running: !!svc.activeRun,
      connected: svc.connected,
      models: svc.modelOrder(),
    })),
    vscode.commands.registerCommand("forgepilot.cancel", async () => {
      if (!svc.activeRun) {
        if (svc.review.active) svc.review.cancel();
        return;
      }
      await svc.cancelActive();
      vscode.window.setStatusBarMessage("$(circle-slash) ForgePilot: cancelled. Staged edits discarded.", 6000);
    }),
    vscode.commands.registerCommand("forgepilot.undoLast", async () => {
      const last = svc.history.last;
      if (!last) {
        vscode.window.showInformationMessage("ForgePilot: nothing to undo.");
        return;
      }
      try {
        const undone = await svc.history.undoLast();
        if (undone) {
          svc.engine.invalidate();
          vscode.window.showInformationMessage(`ForgePilot undid "${undone.label}" (${undone.files.map((f) => f.path).join(", ")}).`);
          panel.post({ type: "notice", level: "info", text: `Undid "${undone.label}": restored ${undone.files.map((f) => f.path).join(", ")}.` });
        }
      } catch (e) {
        vscode.window.showErrorMessage(`ForgePilot undo failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("forgepilot.openSession", () => panel.post({ type: "openSessionRequest" })),
    vscode.commands.registerCommand("forgepilot.reconnect", () => connect(true)),
    vscode.commands.registerCommand("forgepilot.selectModel", () => vscode.commands.executeCommand("forgepilot.selectModels")),
    vscode.commands.registerCommand("forgepilot.selectModels", async () => {
      await svc.refreshModels();
      if (!svc.available.length) {
        vscode.window.showWarningMessage("TrueForge has no models configured. Add one under Settings → Models in the TrueForge UI or run scripts/configure-models.mjs.");
        return;
      }
      const primary = await vscode.window.showQuickPick(svc.available, { title: "ForgePilot: primary model (configured in TrueForge)" });
      if (!primary) return;
      const rest = svc.available.filter((m) => m !== primary);
      let fallbacks: string[] = [];
      if (rest.length) {
        const picked = await vscode.window.showQuickPick(rest, { title: "Automatic fallback models, in order (optional)", canPickMany: true });
        fallbacks = picked ?? [];
      }
      if (svc.cfg<string[]>("models", []).length) {
        await vscode.workspace.getConfiguration("forgepilot").update("models", [primary, ...fallbacks], vscode.ConfigurationTarget.Workspace);
      }
      await svc.setModelOrder([primary, ...fallbacks]);
      await connect(false);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("forgepilot.models")) svc.refreshModels().then(renderConn);
      if (e.affectsConfiguration("forgepilot.trueforgeUrl")) void connect(true);
    }),
    { dispose: () => svc.mcp.stop() },
  );

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(async (w) => {
      if (!w.focused || !svc.connected || !svc.mcp.port) return;
      try {
        await svc.forge.registerMcpServer(MCP_SERVER_NAME, svc.mcp.url, svc.mcp.token);
      } catch {
        return;
      }
    }),
  );

  renderConn();
  void connect(true);
  const timer = setInterval(async () => {
    const was = svc.connected;
    const ok = await svc.forge.ping();
    if (ok && !was) await connect(false);
    if (!ok && was) {
      svc.connected = false;
      renderConn();
    }
  }, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export async function deactivate() {
  if (services?.activeRun) await services.cancelActive();
  services?.mcp?.stop();
}
