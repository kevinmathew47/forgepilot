# ForgePilot: an editor-native coding agent on TrueForge

## 1. Team

TODO: names, college or employer, GitHub handles.

## 2. Starting point

Written from scratch (no fork of Cline, Continue, Roo Code or opencode). Dependencies: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff` (jsdiff), `zod`. Harness: TrueForge local mode (`npx @truefoundry/trueforge@latest`).

## 3. Architecture on TrueForge

- **Client.** The extension is a TrueForge SDK client. Each request creates a session from the agent definition in `agent/` (the model is filled in from the user's model order), streams the turn with `createTurnStream`, renders every event (`model.message.delta`, tool calls, `tool.response`, `thread.created/done`, compaction, `turn.done` metrics), and cancels with `sessions.cancel`. The extension never calls a model provider.
- **Editor capabilities as MCP tools.** The extension hosts a streamable-HTTP MCP server on `127.0.0.1:8791` and registers it in TrueForge as `forgepilot-editor`. It exposes `find_relevant_code`, `repo_map`, `list_files`, `read_file`, `search_code`, `find_symbol`, `edit_file`, `write_file`, `show_staged_changes`, `discard_staged`, `submit_changes` and `run_command`. The agent decides what to read and change.
- **Approval drives the diff review.** `edit_file`/`write_file` only stage edits in an in-memory changeset (`read_file` returns the staged view). `submit_changes` is listed in `require_approval_for_tools`. When TrueForge pauses with `tool.approval_required`, the extension opens one diff tab per file with per-hunk Accept/Reject CodeLens, mirrored in the panel. Accepting sends `user.tool_approval: allow` and the MCP call writes the accepted hunks as one `WorkspaceEdit`. Rejecting everything sends `deny` with a reason the agent can read.
- **Harness features used.** *Dynamic subagents*: the instructions ask the agent to delegate exploration of separate areas (source, tests, docs); subagent threads render as nested cards. *Deferred tool loading*: eight core tools are preloaded and the rest stay deferred behind TrueForge's `call_tool`, which keeps the tool schema cost low on small models. *Compaction*: triggered at 48k input tokens so long runs fit 32k-context local models; compaction events show in the panel. *Tool approval*, as above. *Sessions*: every run links to its TrueForge session page.
- **Why local MCP over HTTP.** TrueForge connects to remote MCP servers. Serving MCP from the extension host keeps editor state (open buffers, staged edits, review UI) in one process. TrueForge's SSRF guard blocks loopback by default, so the start script allow-lists `127.0.0.1` and `localhost`.

## 4. How context is selected

1. **Explicit:** `@path` and `@Symbol` mentions, with autocomplete, are resolved by the extension and attached verbatim (12k-token cap, files truncated at 400 lines).
2. **Automatic** (`find_relevant_code`, default budget 6,000 tokens, configurable):
   - Index: `git ls-files` (respects .gitignore). Python is chunked at every `def`/`class` (with decorators), docs at section headings, other languages at symbol boundaries, with 80-line windows as the fallback.
   - Ranking: BM25 over chunk tokens (identifier-aware splitting, light stemming, small synonym map such as cli→command/click). File score is best chunk + 0.5×second + 0.25×third, plus path matches. Tests and docs are down-weighted unless the task asks for them.
   - Exact identifiers named in the task (`get_debug_flag`) pull in their defining file and chunk first; files that use them get a smaller boost.
   - Import graph: neighbours of the top source files are boosted. The *test intent* adds `tests/test_<module>.py` and importing tests; the *docs intent* adds the best-matching documentation page.
   - Packing: each chosen file costs a header (path, role, why, outline); the best chunks are then added greedily, at most three per file, until the budget is spent. Files that did not fit are listed as "left out".
   - The tool result goes to the model, and the same selection is rendered in the panel's **Context** card (file, role, score, tokens, why), so judges can see which files were chosen and why.
3. **Inline edit:** imports of the file, 25 lines above and 15 below the selection, and definitions of identifiers used in the selection from other files, within a 3,000-token budget.

On Task B's wording, the engine picks `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst` within 6,000 of Flask's ~17k lines.

## 5. Model setup

Models are configured only in TrueForge, either through the UI or `scripts/configure-models.mjs` with `config/models.example.json`. The user picks a primary and ordered fallbacks with **ForgePilot: Select Models** (or the `forgepilot.models` setting). Nothing is hard-coded.

| Model | Where it ran | Cost |
|---|---|---|
| `google-gemini/gemini-3-5-flash-lite` (primary) | Google AI Studio free tier, TrueForge catalog provider | $0 |
| `google-gemini/gemini-3-5-flash` (first fallback) | Google AI Studio free tier | $0 |
| `ollama/qwen2-5-7b` (Qwen2.5 7B Q4_K_M, last fallback) | Local Ollama on an RTX 3050 Ti 4 GB, OpenAI-compatible endpoint | $0 |
| `openai/gpt-4-1-mini` with a deliberately invalid key | Only to demonstrate Task C | $0 |

Free-tier limits shaped the resilience design. `gemini-2.5-flash` allowed 20 requests per day and `gemini-3.5-flash` 5 per minute, and every agent tool call is one request. The fallback policy therefore separates:
- per-minute 429s: wait the server's `retry in Ns`, up to 12 times, and resume the *same* session with staged edits kept;
- per-day quota, auth and validation errors: switch to the next model at once.

The local 7B model handles Task A on its own but was not reliable enough for the three-file Task B. Task B passed with `gemini-3.5-flash-lite` in 474 s (including rate-limit waits) over four review rounds, with 59/59 tests in `tests/test_cli.py` passing.

## 6. Scorecard

| Criterion | Video timestamp | Claim |
|---|---|---|
| A1 Inline edit | TODO | Diff streams into a diff editor; per-hunk Accept/Reject CodeLens and panel buttons |
| A2 Agent mode | TODO | One request; agent finds and edits cli.py, test_cli.py and cli.rst unprompted |
| A3 Streaming and cancel | TODO | Tokens stream live; Stop cancels in ~0.3 s with no file changed (staged edits only) |
| B1 Context | TODO | Context card shows chosen files, reasons, token budget and what was left out |
| B2 Diff safety | TODO | Hunk-by-hunk review before any write; Undo restores the files on screen |
| B3 Resilience | TODO | Invalid key → automatic fallback to the second model; git status clean |
| B4 TrueForge depth | TODO | MCP tools, approval-driven review, subagents, deferred tools, compaction in the session view |
| C1 Video | — | A, B, C in order, each verified on screen |
| C2 Write-up | — | This document |

## 7. Tools used

VS Code, Node.js 22, TypeScript, esbuild, TrueForge local mode, Ollama, `@vscode/test-electron` for automated end-to-end runs of tasks A and C and of cancellation. AI coding assistant: Claude Code (Claude Opus) helped write and test the code.

## 8. Known limitations and next month

- `search_code` and retrieval read the on-disk index, not staged edits; only `read_file` shows the staged view.
- Retrieval is lexical plus structural. Next: embeddings as a third signal, and call-graph edges from a language server (`vscode.executeReferenceProvider`).
- One VS Code window per TrueForge server: the MCP server name is global, so the last window to connect wins.
- A failure in the middle of a run restarts the task on the fallback model from scratch (staged edits are discarded, approved changes are kept).
- `run_command` uses an allow-list plus a confirmation prompt, not a sandbox (TrueForge's sandbox needs Daytona).
- Small local models follow the tool protocol but are slow (~2 min for Task A on a 4 GB GPU) and less reliable on multi-file tasks. When a model stops before editing, ForgePilot sends up to three automatic follow-up turns in the same session.
- Free-tier rate limits make Task B slow (most of the 474 s is waiting). A paid key or a gateway with higher limits removes the waits.
- With another month: semantic retrieval, LSP-backed symbol graphs, a per-hunk "edit this hunk" action, and contributing an upstream TrueForge feature for model fallback chains inside the agent spec, so clients no longer need to implement it.
