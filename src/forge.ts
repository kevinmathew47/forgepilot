import { TrueForge, isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export type AnyEvent = Record<string, any> & { type: string; id: string };

export interface PendingCall {
  id: string;
  threadId: string;
  name: string;
  server?: string;
  args: Record<string, any>;
  kind: "approval" | "response";
}

export interface TurnHandlers {
  onSession?(sessionId: string): void;
  onEvent?(event: AnyEvent, merged: AnyEvent | undefined): void;
  onPause?(calls: PendingCall[]): Promise<AnyEvent[]>;
}

export interface TurnResult {
  status: "done" | "cancelled" | "error";
  sessionId?: string;
  turnId?: string;
  output?: string;
  message?: string;
  metrics?: Record<string, number>;
}

export class ForgeError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "auth" | "model" | "transient" | "other",
  ) {
    super(message);
  }
}

export function classifyError(message: string): ForgeError["kind"] {
  const m = message.toLowerCase();
  if (/api[_ -]?key|unauthori[sz]ed|\b401\b|\b403\b|permission|forbidden|invalid.*(key|token|credential)|authentication/.test(m)) return "auth";
  if (/\(http 4(0\d|1\d|2[0-8])\)|unrecognized|invalid_type|validation/.test(m)) return "model";
  if (/not[_ ]found|\b404\b|unknown model|no such model|does not exist|model.*not.*(available|configured)|invalid model/.test(m)) return "model";
  if (/econnrefused|enotfound|eai_again|fetch failed|timed? ?out|timeout|\b429\b|rate.?limit|\b5\d\d\b|overloaded|unavailable|socket|network|connect/.test(m)) return "transient";
  return "other";
}

export class Forge {
  client: TrueForge;

  constructor(public baseUrl: string) {
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 900, maxRetries: 0 });
  }

  setBaseUrl(url: string) {
    this.baseUrl = url;
    this.client = new TrueForge({ baseUrl: url, timeoutInSeconds: 900, maxRetries: 0 });
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.server.getCapabilities({ timeoutInSeconds: 4, maxRetries: 0 });
      return true;
    } catch {
      return false;
    }
  }

  async models(): Promise<string[]> {
    const res = await this.client.models.list({ timeoutInSeconds: 8, maxRetries: 0 });
    return res.data.map((m) => m.name);
  }

  async registerMcpServer(name: string, url: string, token: string) {
    await this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: "remote",
        name,
        url,
        auth: { type: "header", headers: { Authorization: `Bearer ${token}` } },
        description: "VS Code editor tools from the ForgePilot extension: code retrieval, file reading and search, staged edits with hunk review, and terminal commands.",
      },
    } as any);
  }

  async upsertAgent(name: string, manifest: Record<string, any>, description: string) {
    const existing: any[] = [];
    for await (const a of await this.client.agents.list()) existing.push(a);
    const found = existing.find((a) => a.name === name);
    if (found) await this.client.agents.update(found.id, { description, manifest } as any);
    else await this.client.agents.create({ name, description, manifest } as any);
  }

  sessionUrl(sessionId: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/sessions/${sessionId}`;
  }

  async cancel(sessionId: string) {
    try {
      await this.client.sessions.cancel(sessionId, {} as any, { timeoutInSeconds: 5, maxRetries: 0 });
    } catch {
      return;
    }
  }

  async createSession(spec: Record<string, any>, title?: string): Promise<string> {
    try {
      const { data } = await this.client.sessions.create({ agent: { spec } } as any, { timeoutInSeconds: 20, maxRetries: 0 });
      return data.id;
    } catch (e) {
      throw wrapError(e);
    }
  }

  async runTurn(sessionId: string, content: string, signal: AbortSignal, handlers: TurnHandlers): Promise<TurnResult> {
    const events = new Map<string, AnyEvent>();
    let turnId: string | undefined;
    let lastEventId: string | undefined;
    const pending: AnyEvent[] = [];

    const consume = async (stream: AsyncIterable<any>): Promise<TurnResult | "paused"> => {
      for await (const raw of stream) {
        const event = raw as AnyEvent;
        if (signal.aborted) return { status: "cancelled", sessionId, turnId };
        lastEventId = event.id;
        if (event.type === "turn.created") turnId = event.turnId;
        let merged: AnyEvent | undefined;
        if (isEventDelta(event as any)) {
          const base = events.get(event.id);
          if (base) {
            mergeEventDelta(base as any, event as any);
            merged = base;
          }
        } else {
          events.set(event.id, event);
          merged = event;
        }
        handlers.onEvent?.(event, merged);
        if (event.type === "tool.approval_required" || event.type === "tool.response_required") pending.push(event);
        if (event.type === "turn.update" && event.state?.status === "paused") return "paused";
        if (event.type === "turn.done") {
          const st = event.state ?? {};
          if (st.status === "done") return { status: "done", sessionId, turnId, output: st.output?.content ?? "", metrics: st.metrics };
          if (st.status === "cancelled") return { status: "cancelled", sessionId, turnId, message: st.reason };
          return { status: "error", sessionId, turnId, message: st.message ?? "The turn failed.", metrics: st.metrics };
        }
      }
      return signal.aborted ? { status: "cancelled", sessionId, turnId } : "paused";
    };

    try {
      const stream = await this.client.sessions.createTurnStream(
        sessionId,
        { input: [{ type: "user.message", content }] } as any,
        { abortSignal: signal, timeoutInSeconds: 900, maxRetries: 0 },
      );
      let result = await consume(stream as any);
      while (result === "paused") {
        if (signal.aborted) return { status: "cancelled", sessionId, turnId };
        if (!turnId) return { status: "error", sessionId, message: "Turn paused before it was created." };
        const calls = pending.splice(0).flatMap((p) => resolveCalls(p, events));
        if (!calls.length) {
          return { status: "error", sessionId, turnId, message: "TrueForge paused the turn for input ForgePilot cannot provide (for example an MCP sign-in)." };
        }
        const answers = handlers.onPause ? await handlers.onPause(calls) : [];
        if (signal.aborted) return { status: "cancelled", sessionId, turnId };
        const resume = await this.client.sessions.subscribeToTurn(
          sessionId,
          turnId,
          { afterEventId: lastEventId } as any,
          { abortSignal: signal, timeoutInSeconds: 900, maxRetries: 0 },
        );
        if (answers.length) {
          await this.client.sessions.createTurnEvents(sessionId, turnId, { events: answers } as any, { timeoutInSeconds: 20, maxRetries: 0 });
        }
        result = await consume(resume as any);
      }
      return result;
    } catch (e) {
      if (signal.aborted) return { status: "cancelled", sessionId, turnId };
      const err = wrapError(e);
      return { status: "error", sessionId, turnId, message: err.message };
    }
  }
}

function resolveCalls(event: AnyEvent, events: Map<string, AnyEvent>): PendingCall[] {
  const out: PendingCall[] = [];
  for (const ref of event.toolCalls ?? []) {
    const msg = events.get(ref.sourceEventId);
    const call = msg?.toolCalls?.find((tc: any) => tc.id === ref.id);
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(call?.function?.arguments || "{}");
    } catch {
      args = {};
    }
    let name = call?.toolInfo?.name ?? call?.function?.name ?? "unknown";
    let server = call?.toolInfo?.type === "mcp" ? call.toolInfo.serverName : undefined;
    if (name === "call_tool" && args.tool_name) {
      name = args.tool_name;
      server = args.mcp_server;
      args = args.arguments ?? args.args ?? args.input ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
    }
    out.push({
      id: ref.id,
      threadId: event.threadId ?? "main",
      name,
      server,
      args,
      kind: event.type === "tool.approval_required" ? "approval" : "response",
    });
  }
  return out;
}

export function wrapError(e: unknown): ForgeError {
  const anyE = e as any;
  const status = anyE?.statusCode ?? anyE?.status;
  const body = anyE?.body ? (typeof anyE.body === "string" ? anyE.body : JSON.stringify(anyE.body)) : "";
  const raw = `${anyE?.message ?? String(e)}${status ? ` (HTTP ${status})` : ""}${body ? `: ${body.slice(0, 400)}` : ""}`;
  const cause = anyE?.cause?.code ?? anyE?.cause?.message ?? "";
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(`${raw} ${cause}`) && !status) {
    return new ForgeError(`Cannot reach TrueForge. Is it running? (${cause || raw})`, "unreachable");
  }
  const kind = classifyError(raw);
  return new ForgeError(raw, kind);
}
