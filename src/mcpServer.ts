import * as http from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface ToolHost {
  findRelevantCode(task: string, budget?: number, maxFiles?: number): Promise<string>;
  repoMap(): Promise<string>;
  listFiles(glob?: string, dir?: string): Promise<string>;
  readFile(path: string, start?: number, end?: number): Promise<string>;
  searchCode(query: string, regex?: boolean, glob?: string, max?: number): Promise<string>;
  findSymbol(name: string, includeBody?: boolean): Promise<string>;
  editFile(path: string, edits: { old_text: string; new_text: string }[], reason?: string): Promise<string>;
  writeFile(path: string, content: string, reason?: string): Promise<string>;
  showStaged(): Promise<string>;
  discardStaged(path?: string): Promise<string>;
  submitChanges(summary: string): Promise<string>;
  runCommand(command: string, timeoutSeconds?: number): Promise<string>;
  onToolCall(name: string, args: unknown): void;
}

type Handler = (args: any) => Promise<string>;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function buildServer(host: ToolHost): McpServer {
  const server = new McpServer({ name: "forgepilot-editor", version: "0.1.0" });
  const reg = (name: string, description: string, shape: z.ZodRawShape, readOnly: boolean, fn: Handler, destructive = false) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: shape,
        annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false },
      },
      async (args: any) => {
        host.onToolCall(name, args);
        try {
          return text(await fn(args ?? {}));
        } catch (e) {
          return errorText(`Error: ${(e as Error).message}`);
        }
      },
    );
  };

  reg(
    "find_relevant_code",
    "Rank the repository's files for a task and return the best matches within a token budget: each chosen file with the reason it was chosen, its outline, and the most relevant code excerpts with line numbers. Call this first for any task where you do not already know which files to change.",
    {
      task: z.string().describe("The task or question in plain language."),
      budget_tokens: z.number().int().min(500).max(30000).optional().describe("Token budget for the returned context. Default comes from the user's settings."),
      max_files: z.number().int().min(1).max(15).optional(),
    },
    true,
    (a) => host.findRelevantCode(a.task, a.budget_tokens, a.max_files),
  );
  reg("repo_map", "Compact directory tree of the workspace with the top-level classes and functions of each file.", {}, true, () => host.repoMap());
  reg(
    "list_files",
    "List workspace files, optionally filtered by a glob (e.g. '**/*.py', 'docs/*.rst') or a directory.",
    { glob: z.string().optional(), dir: z.string().optional() },
    true,
    (a) => host.listFiles(a.glob, a.dir),
  );
  reg(
    "read_file",
    "Read a workspace file with line numbers. Shows your staged (not yet applied) edits if any. Read only the line range you need for large files.",
    {
      path: z.string().describe("Workspace-relative path."),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    },
    true,
    (a) => host.readFile(a.path, a.start_line, a.end_line),
  );
  reg(
    "search_code",
    "Search file contents across the workspace. Literal text by default; set regex true for a regular expression. Returns path:line: text.",
    {
      query: z.string(),
      regex: z.boolean().optional(),
      glob: z.string().optional().describe("Limit to files matching this glob."),
      max_results: z.number().int().min(1).max(300).optional(),
    },
    true,
    (a) => host.searchCode(a.query, a.regex, a.glob, a.max_results),
  );
  reg(
    "find_symbol",
    "Find where a function, class, method or variable is defined. Use it to confirm a symbol exists before you edit or call it.",
    { name: z.string(), include_body: z.boolean().optional() },
    true,
    (a) => host.findSymbol(a.name, a.include_body),
  );
  reg(
    "edit_file",
    "Stage search-and-replace edits to an existing file. Nothing is written to disk until the user approves submit_changes. old_text must be copied exactly from read_file output without the line-number prefix and must match exactly one place; include enough surrounding lines to make it unique.",
    {
      path: z.string(),
      edits: z
        .array(z.object({ old_text: z.string(), new_text: z.string() }))
        .min(1),
      reason: z.string().optional().describe("One line on why this change is needed."),
    },
    false,
    (a) => host.editFile(a.path, a.edits, a.reason),
  );
  reg(
    "write_file",
    "Stage the full content of a new file (or a complete rewrite of a small file). Nothing is written to disk until the user approves submit_changes.",
    { path: z.string(), content: z.string(), reason: z.string().optional() },
    false,
    (a) => host.writeFile(a.path, a.content, a.reason),
  );
  reg("show_staged_changes", "Show a unified diff of every staged edit that has not been submitted yet.", {}, true, () => host.showStaged());
  reg(
    "discard_staged",
    "Throw away staged edits for one file, or all staged edits when path is omitted.",
    { path: z.string().optional() },
    false,
    (a) => host.discardStaged(a.path),
  );
  reg(
    "submit_changes",
    "Send every staged edit to the user for hunk-by-hunk review. The user accepts or rejects each hunk; accepted hunks are then written to disk as one undoable change. Call this once when your edits for the task are complete. The result lists what was applied and rejected.",
    { summary: z.string().describe("Short summary of the change for the reviewer.") },
    false,
    (a) => host.submitChanges(a.summary),
    true,
  );
  reg(
    "run_command",
    "Run a shell command in the workspace root (for example python -m pytest tests/test_cli.py -q) and return its exit code and output. Only allow-listed commands run without asking the user. Run tests only after submit_changes, because staged edits are not on disk.",
    { command: z.string(), timeout_seconds: z.number().int().min(5).max(600).optional() },
    false,
    (a) => host.runCommand(a.command, a.timeout_seconds),
  );
  return server;
}

export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

export class EditorMcpServer {
  private server?: http.Server;
  port = 0;
  readonly token = randomBytes(32).toString("hex");

  constructor(private readonly host: ToolHost) {}

  async start(port: number): Promise<number> {
    this.server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      if (!isLocalHost(req.headers.host) || !isAuthorized(req.headers.authorization, this.token)) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null }),
        );
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", allow: "POST" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      } catch {
        res.writeHead(400).end();
        return;
      }
      const mcp = buildServer(this.host);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null }),
          );
        }
      }
    });
    const tryListen = (p: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          this.server!.off("listening", onListen);
          reject(err);
        };
        const onListen = () => {
          this.server!.off("error", onError);
          resolve((this.server!.address() as { port: number }).port);
        };
        this.server!.once("error", onError);
        this.server!.once("listening", onListen);
        this.server!.listen(p, "127.0.0.1");
      });
    try {
      this.port = await tryListen(port);
    } catch {
      this.port = await tryListen(0);
    }
    return this.port;
  }

  stop() {
    this.server?.close();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }
}
