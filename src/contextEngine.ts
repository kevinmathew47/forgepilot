import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";

export interface Chunk {
  file: string;
  start: number;
  end: number;
  symbol: string;
  text: string;
  tokens: string[];
}

export interface SymbolLoc {
  name: string;
  qualified: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
}

export interface FileInfo {
  path: string;
  text: string;
  lines: string[];
  kind: "source" | "test" | "doc" | "other";
  symbols: SymbolLoc[];
  imports: string[];
}

export interface SelectedFile {
  path: string;
  score: number;
  reasons: string[];
  chunks: { start: number; end: number; symbol: string }[];
  tokens: number;
  role: string;
}

export interface Selection {
  query: string;
  budget: number;
  used: number;
  considered: number;
  files: SelectedFile[];
  omitted: { path: string; score: number }[];
  rendered: string;
  explicit: string[];
}

const TEXT_EXT = new Set([
  ".py", ".pyi", ".rst", ".md", ".txt", ".toml", ".cfg", ".ini", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".json", ".yaml", ".yml", ".html", ".jinja", ".css", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".c", ".h", ".cpp",
]);

const STOP = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the this to was were will with not no you your can should must new add make sure also any all each every other value values use using used like same which when then than there their them they been being do does done get set via per how what why who".split(
    " ",
  ),
);

const SYNONYMS: Record<string, string[]> = {
  cli: ["command", "click", "group"],
  command: ["cli", "click"],
  commands: ["cli", "click", "command"],
  config: ["configuration"],
  configuration: ["config"],
  print: ["echo"],
  prints: ["echo"],
  json: ["dumps"],
  mask: ["secret", "hide"],
  route: ["url", "rule"],
  test: ["pytest"],
  debug: ["flask_debug"],
  env: ["environ"],
  false: ["off", "no"],
};

export function tokenize(text: string): string[] {
  const raw = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2 || STOP.has(t) || /^\d+$/.test(t)) continue;
    out.push(stem(t));
  }
  return out;
}

function stem(t: string): string {
  if (t.length <= 4) return t;
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.endsWith("ing") && t.length > 6) return t.slice(0, -3);
  if (t.endsWith("ed") && t.length > 5) return t.slice(0, -2);
  if (t.endsWith("es") && t.length > 5) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function classify(rel: string): FileInfo["kind"] {
  const lower = rel.toLowerCase();
  if (/(^|\/)tests?\//.test(lower) || /(^|\/)test_[^/]+$/.test(lower) || /_test\.[a-z]+$/.test(lower)) return "test";
  if (/\.(rst|md|txt)$/.test(lower) || lower.startsWith("docs/")) return "doc";
  if (/\.(py|pyi|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|rb|php|c|h|cpp)$/.test(lower)) return "source";
  return "other";
}

function extractPythonSymbols(rel: string, lines: string[]): SymbolLoc[] {
  const out: SymbolLoc[] = [];
  const stack: { indent: number; name: string }[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    if (!m) return;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const qualified = [...stack.map((s) => s.name), m[3]].join(".");
    out.push({ name: m[3], qualified, kind: m[2] === "class" ? "class" : stack.length ? "method" : "function", file: rel, line: i + 1, signature: line.trim() });
    if (m[2] === "class") stack.push({ indent, name: m[3] });
    else stack.push({ indent, name: m[3] });
  });
  lines.forEach((line, i) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*|[a-z_]\w*)\s*(?::[^=]+)?=\s*(?!=)/);
    if (m && !line.startsWith(" ")) {
      out.push({ name: m[1], qualified: m[1], kind: "variable", file: rel, line: i + 1, signature: line.trim().slice(0, 120) });
    }
  });
  return out;
}

function extractGenericSymbols(rel: string, lines: string[]): SymbolLoc[] {
  const out: SymbolLoc[] = [];
  const patterns: [RegExp, string][] = [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "function"],
    [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, "function"],
    [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, "type"],
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"],
    [/^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/, "function"],
  ];
  lines.forEach((line, i) => {
    for (const [re, kind] of patterns) {
      const m = line.match(re);
      if (m) {
        out.push({ name: m[1], qualified: m[1], kind, file: rel, line: i + 1, signature: line.trim().slice(0, 160) });
        break;
      }
    }
  });
  return out;
}

function extractDocHeadings(rel: string, lines: string[]): SymbolLoc[] {
  const out: SymbolLoc[] = [];
  lines.forEach((line, i) => {
    const next = lines[i + 1] ?? "";
    if (line.trim() && /^([=\-~^"`*+#])\1{2,}\s*$/.test(next) && next.trim().length >= Math.min(line.trim().length, 3)) {
      out.push({ name: line.trim(), qualified: line.trim(), kind: "section", file: rel, line: i + 1, signature: line.trim() });
    }
    const md = line.match(/^(#{1,6})\s+(.+)/);
    if (md && rel.endsWith(".md")) out.push({ name: md[2], qualified: md[2], kind: "section", file: rel, line: i + 1, signature: line.trim() });
  });
  return out;
}

function extractPythonImports(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let m = line.match(/^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)/);
    if (m) {
      out.push(m[1]);
      const names = m[2].replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
      for (const n of names) out.push(`${m[1]}${m[1].endsWith(".") ? "" : "."}${n}`);
      continue;
    }
    m = line.match(/^\s*import\s+([\w.]+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

function chunkFile(info: FileInfo): Chunk[] {
  const { lines, path: rel } = info;
  const boundaries = new Set<number>([0]);
  if (rel.endsWith(".py") || rel.endsWith(".pyi")) {
    for (const s of info.symbols) {
      if (s.kind === "variable") continue;
      let start = s.line - 1;
      while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
      boundaries.add(start);
    }
  } else if (info.kind === "doc") {
    for (const s of info.symbols) boundaries.add(Math.max(0, s.line - 1));
  } else {
    for (const s of info.symbols) boundaries.add(Math.max(0, s.line - 1));
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const chunks: Chunk[] = [];
  const symbolAt = (line: number) => {
    let best = "";
    for (const s of info.symbols) {
      if (s.kind === "variable") continue;
      if (s.line - 1 <= line + 3) best = s.qualified;
      else break;
    }
    return best || "(module)";
  };
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const end = (sorted[i + 1] ?? lines.length) - 1;
    for (let s = start; s <= end; s += 80) {
      const e = Math.min(end, s + 79);
      const text = lines.slice(s, e + 1).join("\n");
      if (!text.trim()) continue;
      const symbol = symbolAt(s);
      chunks.push({ file: rel, start: s + 1, end: e + 1, symbol, text, tokens: tokenize(`${rel} ${symbol} ${text}`) });
    }
  }
  return chunks;
}

export class ContextEngine {
  private files = new Map<string, FileInfo>();
  private chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private importGraph = new Map<string, Set<string>>();
  private reverseGraph = new Map<string, Set<string>>();
  private building?: Promise<void>;
  private dirty = true;

  constructor(private readonly root: string) {}

  invalidate() {
    this.dirty = true;
  }

  async ensure() {
    if (!this.dirty && !this.building) return;
    if (!this.building) {
      this.building = this.build().finally(() => (this.building = undefined));
      this.dirty = false;
    }
    await this.building;
  }

  async listFiles(glob?: string, dir?: string): Promise<string[]> {
    let all = await this.gitFiles();
    if (!all) all = await this.walk("");
    const prefix = dir ? dir.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/?$/, "/") : "";
    let out = prefix && prefix !== "/" ? all.filter((p) => p.startsWith(prefix)) : all;
    if (glob) {
      const re = globToRegExp(glob);
      out = out.filter((p) => re.test(p) || re.test(path.posix.basename(p)));
    }
    return out.sort();
  }

  private gitFiles(): Promise<string[] | undefined> {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["ls-files", "-co", "--exclude-standard"],
        { cwd: this.root, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(undefined);
          resolve(stdout.split(/\r?\n/).filter(Boolean));
        },
      );
    });
  }

  private async walk(rel: string): Promise<string[]> {
    const skip = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".tox", ".mypy_cache", ".pytest_cache"]);
    const out: string[] = [];
    let entries: import("fs").Dirent[] = [];
    try {
      entries = await fs.readdir(path.join(this.root, rel), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await this.walk(child)));
      else if (e.isFile()) out.push(child);
      if (out.length > 20000) break;
    }
    return out;
  }

  async search(query: string, opts: { regex?: boolean; glob?: string; maxResults?: number; caseSensitive?: boolean } = {}): Promise<string> {
    await this.ensure();
    const max = opts.maxResults ?? 60;
    let re: RegExp;
    try {
      const flags = opts.caseSensitive ? "" : "i";
      re = opts.regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch (e) {
      return `Invalid regex: ${(e as Error).message}`;
    }
    const globRe = opts.glob ? globToRegExp(opts.glob) : undefined;
    const lines: string[] = [];
    let total = 0;
    const filesHit = new Set<string>();
    for (const f of [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      if (globRe && !globRe.test(f.path) && !globRe.test(path.posix.basename(f.path))) continue;
      f.lines.forEach((l, i) => {
        if (!re.test(l)) return;
        total++;
        filesHit.add(f.path);
        if (lines.length < max) lines.push(`${f.path}:${i + 1}: ${l.trim().slice(0, 200)}`);
      });
    }
    if (!total) return `No matches for ${opts.regex ? "regex" : "text"} "${query}".`;
    return `${total} matches in ${filesHit.size} files${total > max ? ` (showing first ${max})` : ""}:\n${lines.join("\n")}`;
  }

  private async build() {
    const list = await this.listFiles();
    const files = new Map<string, FileInfo>();
    await Promise.all(
      list
        .filter((p) => TEXT_EXT.has(path.extname(p).toLowerCase()))
        .map(async (rel) => {
          try {
            const abs = path.join(this.root, rel);
            const stat = await fs.stat(abs);
            if (stat.size > 400_000) return;
            const text = (await fs.readFile(abs, "utf8")).replace(/\r\n/g, "\n");
            const lines = text.split("\n");
            const kind = classify(rel);
            let symbols: SymbolLoc[] = [];
            if (rel.endsWith(".py") || rel.endsWith(".pyi")) symbols = extractPythonSymbols(rel, lines);
            else if (kind === "doc") symbols = extractDocHeadings(rel, lines);
            else symbols = extractGenericSymbols(rel, lines);
            symbols.sort((a, b) => a.line - b.line);
            const imports = rel.endsWith(".py") ? extractPythonImports(lines) : [];
            files.set(rel, { path: rel, text, lines, kind, symbols, imports });
          } catch {
            return;
          }
        }),
    );
    this.files = files;
    this.chunks = [];
    for (const f of files.values()) this.chunks.push(...chunkFile(f));
    this.df = new Map();
    let total = 0;
    for (const c of this.chunks) {
      total += c.tokens.length;
      for (const t of new Set(c.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = Math.max(1, total / Math.max(1, this.chunks.length));
    this.buildGraph();
  }

  private moduleIndex(): Map<string, string> {
    const map = new Map<string, string>();
    for (const rel of this.files.keys()) {
      if (!rel.endsWith(".py")) continue;
      let mod = rel.replace(/\.py$/, "").replace(/\/__init__$/, "");
      const parts = mod.split("/");
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join(".");
        if (!map.has(key)) map.set(key, rel);
      }
      mod = parts.join(".");
      map.set(mod, rel);
    }
    return map;
  }

  private buildGraph() {
    const modules = this.moduleIndex();
    this.importGraph = new Map();
    this.reverseGraph = new Map();
    for (const f of this.files.values()) {
      const targets = new Set<string>();
      const pkgParts = f.path.replace(/\.py$/, "").split("/");
      pkgParts.pop();
      for (const imp of f.imports) {
        let name = imp;
        const dots = imp.match(/^\.+/)?.[0].length ?? 0;
        if (dots) {
          const base = pkgParts.slice(0, pkgParts.length - (dots - 1));
          name = [...base, imp.slice(dots)].filter(Boolean).join(".").replace(/\//g, ".");
        }
        const candidates = [name, name.split(".").slice(1).join(".")];
        for (const c of candidates) {
          const hit = c && modules.get(c);
          if (hit && hit !== f.path) {
            targets.add(hit);
            break;
          }
        }
      }
      this.importGraph.set(f.path, targets);
      for (const t of targets) {
        if (!this.reverseGraph.has(t)) this.reverseGraph.set(t, new Set());
        this.reverseGraph.get(t)!.add(f.path);
      }
    }
  }

  private bm25(queryTokens: string[], chunk: Chunk): { score: number; hits: string[] } {
    const k1 = 1.2;
    const b = 0.75;
    const n = this.chunks.length;
    const tf = new Map<string, number>();
    for (const t of chunk.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    const hits: string[] = [];
    for (const q of new Set(queryTokens)) {
      const f = tf.get(q);
      if (!f) continue;
      const df = this.df.get(q) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * chunk.tokens.length) / this.avgLen)));
      hits.push(q);
    }
    return { score, hits };
  }

  async findSymbol(name: string): Promise<SymbolLoc[]> {
    await this.ensure();
    const lower = name.toLowerCase();
    const out: SymbolLoc[] = [];
    for (const f of this.files.values()) {
      for (const s of f.symbols) {
        if (s.name === name || s.qualified === name || s.qualified.endsWith("." + name)) out.push(s);
      }
    }
    if (out.length) return out;
    for (const f of this.files.values()) {
      for (const s of f.symbols) if (s.name.toLowerCase().includes(lower) && s.kind !== "section") out.push(s);
    }
    return out.slice(0, 30);
  }

  async symbolBody(loc: SymbolLoc, maxLines = 120): Promise<string> {
    await this.ensure();
    const f = this.files.get(loc.file);
    if (!f) return "";
    const start = loc.line - 1;
    const indent = f.lines[start].match(/^\s*/)![0].length;
    let end = start + 1;
    while (end < f.lines.length && end - start < maxLines) {
      const l = f.lines[end];
      if (l.trim() && l.match(/^\s*/)![0].length <= indent && !/^\s*[)\]}]/.test(l)) break;
      end++;
    }
    return f.lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}| ${l}`)
      .join("\n");
  }

  async outline(rel: string): Promise<string> {
    await this.ensure();
    const f = this.files.get(rel);
    if (!f) return "";
    return f.symbols
      .filter((s) => s.kind !== "variable" || /^[A-Z_]+$/.test(s.name))
      .map((s) => `${s.line}: ${"  ".repeat(Math.max(0, s.qualified.split(".").length - 1))}${s.signature}`)
      .join("\n");
  }

  async repoMap(budgetTokens = 2500): Promise<string> {
    await this.ensure();
    const lines: string[] = [];
    const byDir = new Map<string, FileInfo[]>();
    for (const f of this.files.values()) {
      const dir = path.posix.dirname(f.path);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(f);
    }
    let used = 0;
    for (const dir of [...byDir.keys()].sort()) {
      const header = `${dir}/`;
      lines.push(header);
      used += estimateTokens(header);
      for (const f of byDir.get(dir)!.sort((a, b) => a.path.localeCompare(b.path))) {
        const top = f.symbols.filter((s) => (s.kind === "class" || s.kind === "function") && !s.qualified.includes(".")).map((s) => s.name);
        const line = `  ${path.posix.basename(f.path)}${top.length ? ": " + top.slice(0, 14).join(", ") + (top.length > 14 ? ", ..." : "") : ""}`;
        used += estimateTokens(line);
        if (used > budgetTokens) {
          lines.push("  ... (repo map truncated at budget)");
          return lines.join("\n");
        }
        lines.push(line);
      }
    }
    return lines.join("\n");
  }

  async select(query: string, budget: number, opts: { maxFiles?: number; exclude?: string[]; pinned?: string[] } = {}): Promise<Selection> {
    await this.ensure();
    const maxFiles = opts.maxFiles ?? 7;
    const base = tokenize(query);
    const expanded = new Set(base);
    for (const t of base) for (const s of SYNONYMS[t] ?? []) expanded.add(stem(s));
    const queryTokens = [...expanded];
    const lowerQuery = query.toLowerCase();
    const wantsTests = /\btest(s|ed|ing)?\b|covered|coverage|pytest/.test(lowerQuery);
    const wantsDocs = /\bdoc(s|ument|umented|umentation)?\b|readme|changelog/.test(lowerQuery);

    const chunkScores: { chunk: Chunk; score: number; hits: string[] }[] = [];
    for (const c of this.chunks) {
      const { score, hits } = this.bm25(queryTokens, c);
      if (score > 0) chunkScores.push({ chunk: c, score, hits });
    }
    chunkScores.sort((a, b) => b.score - a.score);

    const perFile = new Map<string, { scores: number[]; hits: Set<string>; symbols: Set<string>; best: typeof chunkScores }>();
    for (const cs of chunkScores) {
      const e = perFile.get(cs.chunk.file) ?? { scores: [], hits: new Set(), symbols: new Set(), best: [] };
      e.scores.push(cs.score);
      cs.hits.forEach((h) => e.hits.add(h));
      if (e.best.length < 6) {
        e.best.push(cs);
        if (cs.chunk.symbol !== "(module)") e.symbols.add(cs.chunk.symbol);
      }
      perFile.set(cs.chunk.file, e);
    }

    const candidates = new Map<string, { score: number; reasons: string[]; role: string }>();
    for (const [file, e] of perFile) {
      const info = this.files.get(file)!;
      const [a = 0, b = 0, c = 0] = e.scores;
      let score = a + 0.5 * b + 0.25 * c;
      const pathTokens = tokenize(file);
      const pathHits = queryTokens.filter((t) => pathTokens.includes(t));
      score += 1.5 * pathHits.length;
      if (info.kind === "test" && !wantsTests) score *= 0.5;
      if (info.kind === "doc" && !wantsDocs) score *= 0.4;
      if (info.kind === "other") score *= 0.5;
      const reasons = [`matches ${[...e.hits].slice(0, 6).join(", ")}${e.symbols.size ? ` in ${[...e.symbols].slice(0, 3).join(", ")}` : ""}`];
      if (pathHits.length) reasons.push(`path mentions ${pathHits.join(", ")}`);
      candidates.set(file, { score, reasons, role: info.kind });
    }

    const topScore = Math.max(1, ...[...candidates.values()].map((c) => c.score));
    const symbolNames = new Set<string>();
    for (const f of this.files.values()) for (const s of f.symbols) if (s.kind !== "section") symbolNames.add(s.name);
    const named = [...new Set(query.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])].filter(
      (id) =>
        symbolNames.has(id) &&
        (/[a-z0-9]_[a-z0-9]/i.test(id) || /[a-z][A-Z]/.test(id) || new RegExp("[`'\"]" + id + "[`'\"(]").test(query)) &&
        !STOP.has(id.toLowerCase()),
    );
    for (const id of named.slice(0, 6)) {
      const defs: SymbolLoc[] = [];
      for (const f of this.files.values()) for (const s of f.symbols) if (s.name === id && (s.kind !== "variable" || /^[A-Z_]+$/.test(id))) defs.push(s);
      if (!defs.length || defs.length > 4) continue;
      for (const d of defs) {
        const cur = candidates.get(d.file) ?? { score: 0, reasons: [], role: this.files.get(d.file)!.kind };
        cur.score = Math.max(cur.score, topScore) + topScore * 0.5;
        cur.reasons.unshift(`defines \`${d.qualified}\` (line ${d.line}), which the task names`);
        candidates.set(d.file, cur);
        const chunk = this.chunks.find((c) => c.file === d.file && c.start <= d.line && c.end >= d.line);
        if (chunk) {
          const existing = chunkScores.find((c) => c.chunk === chunk);
          const boosted = (chunkScores[0]?.score ?? 1) + 1;
          if (existing) existing.score = boosted;
          else chunkScores.push({ chunk, score: boosted, hits: [id] });
        }
      }
      let users = 0;
      for (const f of this.files.values()) {
        if (users >= 3 || defs.some((d) => d.file === f.path) || f.kind !== "source") continue;
        if (!new RegExp(`\\b${id}\\b`).test(f.text)) continue;
        const cur = candidates.get(f.path);
        if (!cur) continue;
        cur.score += topScore * 0.2;
        cur.reasons.push(`uses \`${id}\``);
        users++;
      }
    }
    chunkScores.sort((a, b) => b.score - a.score);

    const ranked = () => [...candidates.entries()].sort((x, y) => y[1].score - x[1].score);
    const topSources = ranked()
      .filter(([f]) => this.files.get(f)!.kind === "source")
      .slice(0, 2);

    for (const [src, meta] of topSources) {
      for (const dep of this.reverseGraph.get(src) ?? []) {
        const info = this.files.get(dep);
        if (!info || info.kind !== "source") continue;
        const cur = candidates.get(dep);
        const boost = meta.score * 0.25;
        if (cur) cur.score += boost * 0.5;
      }
      for (const dep of this.importGraph.get(src) ?? []) {
        const cur = candidates.get(dep);
        if (cur) {
          cur.score += meta.score * 0.1;
          if (!cur.reasons.some((r) => r.startsWith("imported by"))) cur.reasons.push(`imported by ${src}`);
        }
      }
    }

    if (wantsTests) {
      for (const [src, meta] of topSources) {
        const stemName = path.posix.basename(src).replace(/\.\w+$/, "");
        const guesses = [...this.files.keys()].filter((f) => this.files.get(f)!.kind === "test" && path.posix.basename(f).replace(/\.\w+$/, "") === `test_${stemName}`);
        const importers = [...(this.reverseGraph.get(src) ?? [])].filter((f) => this.files.get(f)!.kind === "test");
        for (const t of new Set([...guesses, ...importers.slice(0, 1)])) {
          const cur = candidates.get(t) ?? { score: 0, reasons: [], role: "test" };
          cur.score = Math.max(cur.score, meta.score * 0.85);
          cur.reasons.unshift(`test counterpart of ${src} (task asks for tests)`);
          candidates.set(t, cur);
        }
      }
    }

    if (wantsDocs) {
      const docs = ranked().filter(([f]) => this.files.get(f)!.kind === "doc").slice(0, 2);
      const best = ranked()[0]?.[1].score ?? 1;
      for (const [d, meta] of docs) {
        meta.score = Math.max(meta.score, best * 0.7);
        meta.reasons.unshift("best-matching documentation page (task asks for docs)");
      }
    }

    for (const p of opts.pinned ?? []) {
      const cur = candidates.get(p) ?? { score: 0, reasons: [], role: this.files.get(p)?.kind ?? "source" };
      cur.score += 1000;
      cur.reasons.unshift("mentioned explicitly");
      candidates.set(p, cur);
    }
    for (const x of opts.exclude ?? []) candidates.delete(x);

    const order = ranked().filter(([f]) => this.files.has(f));
    const chosen = order.slice(0, maxFiles);
    const omitted = order.slice(maxFiles, maxFiles + 8).map(([p, m]) => ({ path: p, score: round(m.score) }));

    let used = 0;
    const header = (n: number) => `Context selected for: "${query.slice(0, 160)}"\n`;
    used += estimateTokens(header(0));
    const selected: SelectedFile[] = [];
    const sections: string[] = [];
    for (const [file, meta] of chosen) {
      const info = this.files.get(file)!;
      const outline = info.symbols
        .filter((s) => s.kind === "class" || s.kind === "function" || s.kind === "section")
        .slice(0, 25)
        .map((s) => `${s.line}:${s.qualified}`)
        .join(", ");
      const head = `\n### ${file}  [${info.kind}, ${info.lines.length} lines, score ${round(meta.score)}]\nwhy: ${meta.reasons.join("; ")}\noutline: ${outline || "(none)"}\n`;
      const headTokens = estimateTokens(head);
      if (used + headTokens > budget) {
        omitted.unshift({ path: file, score: round(meta.score) });
        continue;
      }
      used += headTokens;
      selected.push({ path: file, score: round(meta.score), reasons: meta.reasons, chunks: [], tokens: headTokens, role: info.kind });
      sections.push(head);
    }

    const chunkPool = chunkScores.filter((c) => selected.some((s) => s.path === c.chunk.file));
    const perFileTaken = new Map<string, number>();
    for (const cs of chunkPool) {
      const sel = selected.find((s) => s.path === cs.chunk.file)!;
      const taken = perFileTaken.get(sel.path) ?? 0;
      if (taken >= 3) continue;
      const body = cs.chunk.text
        .split("\n")
        .slice(0, 60)
        .map((l, i) => `${cs.chunk.start + i}| ${l}`)
        .join("\n");
      const block = `\n--- ${sel.path} lines ${cs.chunk.start}-${Math.min(cs.chunk.end, cs.chunk.start + 59)} (${cs.chunk.symbol}) ---\n${body}\n`;
      const cost = estimateTokens(block);
      if (used + cost > budget) continue;
      used += cost;
      sel.tokens += cost;
      sel.chunks.push({ start: cs.chunk.start, end: Math.min(cs.chunk.end, cs.chunk.start + 59), symbol: cs.chunk.symbol });
      perFileTaken.set(sel.path, taken + 1);
      const idx = selected.indexOf(sel);
      sections[idx] += block;
    }

    const summary =
      header(0) +
      `budget ${budget} tokens, used ${used}; ${candidates.size} files matched, ${selected.length} chosen` +
      (omitted.length ? `; next best (not included): ${omitted.slice(0, 5).map((o) => o.path).join(", ")}` : "") +
      "\nLine numbers are for reference only; do not copy them into edits.\n";
    return {
      query,
      budget,
      used,
      considered: candidates.size,
      files: selected,
      omitted,
      rendered: summary + sections.join(""),
      explicit: opts.pinned ?? [],
    };
  }

  async identifiersContext(text: string, excludeFile: string, budget: number): Promise<{ rendered: string; used: string[] }> {
    await this.ensure();
    const ids = new Set((text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter((x) => !STOP.has(x.toLowerCase())));
    const parts: string[] = [];
    const usedNames: string[] = [];
    let used = 0;
    for (const id of ids) {
      const locs = (await this.findSymbol(id)).filter((l) => l.name === id && l.kind !== "section" && l.kind !== "variable");
      if (!locs.length || locs.length > 3) continue;
      for (const loc of locs.slice(0, 1)) {
        if (loc.file === excludeFile) continue;
        const body = await this.symbolBody(loc, 40);
        const block = `\n--- ${loc.file}:${loc.line} ${loc.qualified} ---\n${body}\n`;
        const cost = estimateTokens(block);
        if (used + cost > budget) continue;
        used += cost;
        parts.push(block);
        usedNames.push(`${loc.qualified} (${loc.file})`);
      }
    }
    return { rendered: parts.join(""), used: usedNames };
  }

  hasFile(rel: string): boolean {
    return this.files.has(rel);
  }

  allPaths(): string[] {
    return [...this.files.keys()];
  }
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        re += "(" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")";
        i = end;
      } else re += "\\{";
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
