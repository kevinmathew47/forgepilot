import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Forge } from "./forge";
import { ContextEngine } from "./contextEngine";
import { Changeset, History } from "./changeset";
import { ReviewController } from "./review";
import { AgentToolHost } from "./agentTools";
import { EditorMcpServer } from "./mcpServer";

export const MCP_SERVER_NAME = "forgepilot-editor";

export interface AgentDefinition {
  name: string;
  description: string;
  manifest: Record<string, any>;
}

export class Services {
  readonly forge: Forge;
  readonly changeset = new Changeset();
  readonly history = new History();
  readonly review = new ReviewController();
  engine!: ContextEngine;
  host!: AgentToolHost;
  mcp!: EditorMcpServer;
  readonly log: vscode.OutputChannel;
  readonly status: vscode.StatusBarItem;
  private readonly modelsChanged = new vscode.EventEmitter<string[]>();
  readonly onModelsChanged = this.modelsChanged.event;
  connected = false;
  available: string[] = [];
  activeRun?: { abort: () => Promise<void>; kind: "agent" | "inline" };

  constructor(readonly context: vscode.ExtensionContext) {
    this.forge = new Forge(this.cfg("trueforgeUrl", "http://localhost:8790"));
    this.log = vscode.window.createOutputChannel("ForgePilot");
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = "forgepilot.cancel";
    context.subscriptions.push(this.log, this.status);
  }

  cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("forgepilot").get<T>(key, fallback);
  }

  definition(file: "forgepilot-coder" | "forgepilot-inline"): AgentDefinition {
    const p = path.join(this.context.extensionPath, "agent", `${file}.json`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  spec(file: "forgepilot-coder" | "forgepilot-inline", model: string): Record<string, any> {
    const def = this.definition(file);
    const manifest = JSON.parse(JSON.stringify(def.manifest));
    manifest.model.name = model;
    return manifest;
  }

  async refreshModels(): Promise<string[]> {
    try {
      this.available = await this.forge.models();
      this.connected = true;
    } catch {
      this.connected = false;
      this.available = [];
    }
    this.modelsChanged.fire(this.modelOrder());
    return this.available;
  }

  modelOrder(): string[] {
    const configured = this.cfg<string[]>("models", []).filter(Boolean);
    const stored = this.context.workspaceState.get<string[]>("forgepilot.modelOrder");
    const order = configured.length ? configured : stored?.length ? stored : this.available;
    return [...new Set(order)];
  }

  async setModelOrder(models: string[]) {
    await this.context.workspaceState.update("forgepilot.modelOrder", models);
    this.modelsChanged.fire(this.modelOrder());
  }

  showRunning(text: string) {
    this.status.text = `$(loading~spin) ${text}  $(close) Cancel`;
    this.status.tooltip = "Click or press Ctrl+Alt+X to cancel";
    this.status.show();
  }

  hideRunning() {
    this.status.hide();
  }

  async cancelActive() {
    const run = this.activeRun;
    if (run) await run.abort();
  }
}
