import * as vscode from "vscode";
import * as path from "path";
import { StagedFile } from "./changeset";
import { computeHunks, countChanges, Hunk, hunkPreviewRange, previewText } from "./hunks";

export const ORIG_SCHEME = "forgepilot-orig";
export const PROP_SCHEME = "forgepilot-prop";

export interface ReviewFile {
  file: StagedFile;
  hunks: Hunk[];
}

export interface ReviewOutcome {
  decision: "apply" | "discard";
  files: ReviewFile[];
}

export interface ReviewSummaryFile {
  path: string;
  isNew: boolean;
  added: number;
  removed: number;
  hunks: { id: number; state: string; preview: string; origStart: number; added: number; removed: number }[];
}

export interface ReviewSummary {
  id: string;
  title: string;
  streaming: boolean;
  files: ReviewSummaryFile[];
}

class Review {
  streaming = false;
  private resolveFn?: (o: ReviewOutcome) => void;
  readonly done: Promise<ReviewOutcome>;
  finished = false;

  constructor(
    readonly id: string,
    readonly title: string,
    readonly files: ReviewFile[],
    readonly autoFinish: boolean,
  ) {
    this.done = new Promise((r) => (this.resolveFn = r));
  }

  finish(decision: "apply" | "discard") {
    if (this.finished) return;
    this.finished = true;
    this.resolveFn?.({ decision, files: this.files });
  }

  get pending(): number {
    return this.files.reduce((n, f) => n + f.hunks.filter((h) => h.state === "pending").length, 0);
  }

  get accepted(): number {
    return this.files.reduce((n, f) => n + f.hunks.filter((h) => h.state === "accepted").length, 0);
  }

  get total(): number {
    return this.files.reduce((n, f) => n + f.hunks.length, 0);
  }
}

export class ReviewController implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private review?: Review;
  private counter = 0;
  private readonly docChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.docChanged.event;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  private readonly stateChanged = new vscode.EventEmitter<ReviewSummary | undefined>();
  readonly onDidChangeState = this.stateChanged.event;

  register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, this),
      vscode.workspace.registerTextDocumentContentProvider(PROP_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: PROP_SCHEME }, this),
      vscode.commands.registerCommand("forgepilot.acceptHunk", (a?: HunkRef) => this.decide(a, "accepted")),
      vscode.commands.registerCommand("forgepilot.rejectHunk", (a?: HunkRef) => this.decide(a, "rejected")),
      vscode.commands.registerCommand("forgepilot.resetHunk", (a?: HunkRef) => this.decide(a, "pending")),
      vscode.commands.registerCommand("forgepilot.acceptAll", () => this.decideAll("accepted")),
      vscode.commands.registerCommand("forgepilot.rejectAll", () => this.decideAll("rejected")),
      vscode.commands.registerCommand("forgepilot.applyReview", () => this.applyCurrent()),
      vscode.commands.registerCommand("forgepilot.discardReview", () => this.cancel()),
      vscode.commands.registerCommand("forgepilot.openReviewFile", (p: string) => this.openFile(p)),
    );
  }

  get active(): boolean {
    return !!this.review && !this.review.finished;
  }

  summary(): ReviewSummary | undefined {
    const r = this.review;
    if (!r || r.finished) return undefined;
    return {
      id: r.id,
      title: r.title,
      streaming: r.streaming,
      files: r.files.map((f) => {
        const c = countChanges(f.hunks);
        return {
          path: f.file.path,
          isNew: !f.file.existed,
          added: c.added,
          removed: c.removed,
          hunks: f.hunks.map((h) => ({
            id: h.id,
            state: h.state,
            origStart: h.origStart + 1,
            added: h.newLines.length,
            removed: h.origLines.length,
            preview: [...h.origLines.map((l) => "- " + l), ...h.newLines.map((l) => "+ " + l)].slice(0, 40).join("\n"),
          })),
        };
      }),
    };
  }

  private uriFor(scheme: string, review: Review, rel: string): vscode.Uri {
    return vscode.Uri.from({ scheme, path: `/${review.id}/${rel}` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const r = this.review;
    if (!r) return "";
    const [, id, ...rest] = uri.path.split("/");
    if (id !== r.id) return "";
    const rel = rest.join("/");
    const f = r.files.find((x) => x.file.path === rel);
    if (!f) return "";
    if (uri.scheme === ORIG_SCHEME) return f.file.original;
    return previewText(f.file.original, f.hunks);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const r = this.review;
    if (!r || r.finished || r.streaming) return [];
    const [, id, ...rest] = doc.uri.path.split("/");
    if (id !== r.id) return [];
    const rel = rest.join("/");
    const f = r.files.find((x) => x.file.path === rel);
    if (!f) return [];
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(top, {
        title: `ForgePilot review: ${r.accepted}/${r.total} accepted, ${r.pending} pending`,
        command: "",
      }),
      new vscode.CodeLens(top, { title: "$(check-all) Accept all", command: "forgepilot.acceptAll" }),
      new vscode.CodeLens(top, { title: "$(close-all) Reject all", command: "forgepilot.rejectAll" }),
    );
    if (!r.autoFinish || r.pending === 0) {
      lenses.push(new vscode.CodeLens(top, { title: "$(save) Apply decisions", command: "forgepilot.applyReview" }));
    }
    for (const h of f.hunks) {
      const range = hunkPreviewRange(f.hunks, h);
      const line = Math.min(Math.max(range.start, 0), Math.max(doc.lineCount - 1, 0));
      const at = new vscode.Range(line, 0, line, 0);
      const ref: HunkRef = { reviewId: r.id, path: f.file.path, hunkId: h.id };
      const label = `Hunk ${h.id + 1}/${f.hunks.length}`;
      if (h.state === "pending") {
        lenses.push(
          new vscode.CodeLens(at, { title: `$(check) Accept ${label}`, command: "forgepilot.acceptHunk", arguments: [ref] }),
          new vscode.CodeLens(at, { title: "$(close) Reject", command: "forgepilot.rejectHunk", arguments: [ref] }),
        );
      } else {
        lenses.push(
          new vscode.CodeLens(at, {
            title: h.state === "accepted" ? `$(pass-filled) ${label} accepted` : `$(circle-slash) ${label} rejected`,
            command: "",
          }),
          new vscode.CodeLens(at, { title: "$(discard) Undo decision", command: "forgepilot.resetHunk", arguments: [ref] }),
        );
      }
    }
    return lenses;
  }

  async start(files: ReviewFile[], title: string, autoFinish: boolean, focusPath?: string): Promise<ReviewOutcome> {
    this.cancel();
    const review = new Review(`r${++this.counter}`, title, files, autoFinish);
    this.review = review;
    await vscode.commands.executeCommand("setContext", "forgepilot.reviewActive", true);
    this.emit();
    const ordered = [...files].sort((a, b) => (a.file.path === focusPath ? 1 : b.file.path === focusPath ? -1 : 0));
    for (const f of ordered) await this.openDiff(review, f);
    return review.done;
  }

  async startStreaming(file: StagedFile, title: string): Promise<StreamingHandle> {
    this.cancel();
    const review = new Review(`r${++this.counter}`, title, [{ file, hunks: [] }], true);
    review.streaming = true;
    this.review = review;
    await vscode.commands.executeCommand("setContext", "forgepilot.reviewActive", true);
    await this.openDiff(review, review.files[0]);
    this.emit();
    return {
      update: (proposed: string) => {
        if (review.finished) return;
        review.files[0].file.proposed = proposed;
        review.files[0].hunks = computeHunks(file.original, proposed);
        this.docChanged.fire(this.uriFor(PROP_SCHEME, review, file.path));
        this.emitThrottled();
      },
      complete: (proposed: string) => {
        review.streaming = false;
        review.files[0].file.proposed = proposed;
        review.files[0].hunks = computeHunks(file.original, proposed);
        this.docChanged.fire(this.uriFor(PROP_SCHEME, review, file.path));
        this.emit();
        if (!review.files[0].hunks.length) review.finish("discard");
        return review.done;
      },
      abort: () => {
        if (this.review === review) this.cancel();
      },
      get finished() {
        return review.finished;
      },
    };
  }

  private async openDiff(review: Review, f: ReviewFile) {
    const left = this.uriFor(ORIG_SCHEME, review, f.file.path);
    const right = this.uriFor(PROP_SCHEME, review, f.file.path);
    const label = `${path.basename(f.file.path)}${f.file.existed ? "" : " (new)"} ↔ ForgePilot proposal`;
    await vscode.commands.executeCommand("vscode.diff", left, right, label, { preview: false, preserveFocus: false });
  }

  private async openFile(rel: string) {
    const r = this.review;
    if (!r) return;
    const f = r.files.find((x) => x.file.path === rel);
    if (f) await this.openDiff(r, f);
  }

  private find(ref?: HunkRef): { f: ReviewFile; h: Hunk } | undefined {
    const r = this.review;
    if (!r || r.finished) return undefined;
    if (ref && ref.reviewId === r.id) {
      const f = r.files.find((x) => x.file.path === ref.path);
      const h = f?.hunks.find((x) => x.id === ref.hunkId);
      return f && h ? { f, h } : undefined;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === PROP_SCHEME) {
      const rel = editor.document.uri.path.split("/").slice(2).join("/");
      const f = r.files.find((x) => x.file.path === rel);
      if (!f) return undefined;
      const line = editor.selection.active.line;
      const h =
        f.hunks.find((x) => {
          const range = hunkPreviewRange(f.hunks, x);
          return line >= range.start - 1 && line <= range.start + Math.max(range.length, 1);
        }) ?? f.hunks.find((x) => x.state === "pending");
      return h ? { f, h } : undefined;
    }
    for (const f of r.files) {
      const h = f.hunks.find((x) => x.state === "pending");
      if (h) return { f, h };
    }
    return undefined;
  }

  decide(ref: HunkRef | undefined, state: Hunk["state"]) {
    const hit = this.find(ref);
    if (!hit || !this.review) return;
    hit.h.state = state;
    this.refresh(hit.f);
    this.maybeAutoFinish();
  }

  decideAll(state: Hunk["state"]) {
    const r = this.review;
    if (!r || r.finished) return;
    for (const f of r.files) {
      for (const h of f.hunks) if (h.state === "pending") h.state = state;
      this.refresh(f);
    }
    this.maybeAutoFinish();
  }

  setHunk(pathRel: string, hunkId: number, state: Hunk["state"]) {
    const r = this.review;
    if (!r) return;
    this.decide({ reviewId: r.id, path: pathRel, hunkId }, state);
  }

  private maybeAutoFinish() {
    const r = this.review;
    if (r && r.autoFinish && r.pending === 0) void this.finishCurrent(r.accepted > 0 ? "apply" : "discard");
  }

  private refresh(f: ReviewFile) {
    const r = this.review;
    if (!r) return;
    this.docChanged.fire(this.uriFor(PROP_SCHEME, r, f.file.path));
    this.emit();
  }

  async applyCurrent() {
    const r = this.review;
    if (!r || r.finished) return;
    if (r.pending > 0) {
      const choice = await vscode.window.showWarningMessage(
        `${r.pending} hunk(s) are still pending. Reject them and apply the ${r.accepted} accepted hunk(s)?`,
        { modal: true },
        "Reject pending and apply",
      );
      if (choice !== "Reject pending and apply") return;
      for (const f of r.files) for (const h of f.hunks) if (h.state === "pending") h.state = "rejected";
    }
    await this.finishCurrent(r.accepted > 0 ? "apply" : "discard");
  }

  cancel() {
    if (this.review && !this.review.finished) void this.finishCurrent("discard");
  }

  private async finishCurrent(decision: "apply" | "discard") {
    const r = this.review;
    if (!r || r.finished) return;
    r.finish(decision);
    await vscode.commands.executeCommand("setContext", "forgepilot.reviewActive", false);
    this.emit();
    await this.closeTabs(r.id);
  }

  private async closeTabs(id: string) {
    const tabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === PROP_SCHEME && input.modified.path.startsWith(`/${id}/`)) {
          tabs.push(tab);
        }
      }
    }
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  private throttle?: NodeJS.Timeout;
  private emitThrottled() {
    if (this.throttle) return;
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      this.emit();
    }, 120);
  }

  private emit() {
    this.lensChanged.fire();
    this.stateChanged.fire(this.summary());
  }
}

export interface HunkRef {
  reviewId: string;
  path: string;
  hunkId: number;
}

export interface StreamingHandle {
  update(proposed: string): void;
  complete(proposed: string): Promise<ReviewOutcome>;
  abort(): void;
  readonly finished: boolean;
}
