# ForgePilot

ForgePilot is a coding agent for VS Code. Its agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's open-source agent harness. It finds the right code in repositories larger than a context window. It makes multi-file changes without being told which files to touch. Every hunk is shown for review before anything reaches disk, and when a model fails it moves on to the next configured model.

**Starting point:** written from scratch. It is not a fork of Cline, Continue, Roo Code or opencode, so there is no upstream fork commit.

**Demo video:** _link added after recording_ · **Write-up:** [docs/WRITEUP.md](docs/WRITEUP.md)

## What it does

| Capability | How |
|---|---|
| Inline edit | Select code, press `Ctrl+Alt+K` (`Cmd+Alt+K` on macOS) and type an instruction. The proposal streams into a diff editor as tokens arrive. Each hunk has **Accept** / **Reject** CodeLens buttons, and they also appear in the side panel. |
| Agent mode | ForgePilot panel in the activity bar. One request drives a TrueForge agent through a loop of `find_relevant_code`, `read_file`, `search_code`, `find_symbol`, `edit_file`, `write_file`, `submit_changes` and `run_command`. |
| Context assembly | `@file` and `@Symbol` mentions (with autocomplete) are attached explicitly. Automatic retrieval ranks the whole repository: BM25 over symbol-level chunks, exact-identifier boosts, import-graph expansion, test-counterpart and documentation intents, then packs results greedily into a token budget. The panel shows which files were chosen, why, and what was left out. |
| Diff review | Agent edits are **staged in memory**. TrueForge's tool-approval pause on `submit_changes` opens the hunk-by-hunk review. Accepted hunks are written as one `WorkspaceEdit` that `Ctrl+Z` can undo, and **Undo last** restores the previous file contents. |
| Streaming and cancellation | Text deltas, tool calls, subagent threads and compaction events come from TrueForge's event stream. **Stop** / `Ctrl+Alt+X` cancels the TrueForge session, aborts the stream, kills running commands and throws away staged edits. Nothing half-applied can remain, because nothing is written until a review completes. |
| Resilience | Models are tried in order. Transient errors (connection refused, timeouts, 429, 5xx) are retried with exponential backoff. Auth and validation errors fail over to the next configured model at once. When every model fails, the user gets a clear message and the workspace is untouched. |

## Architecture

```
VS Code extension (TypeScript)
 ├─ TrueForge client (@truefoundry/trueforge-sdk): sessions, turn streams, approvals, cancel
 ├─ Editor MCP server (streamable HTTP on 127.0.0.1:8791/mcp), registered in TrueForge as "forgepilot-editor"
 │    find_relevant_code · repo_map · list_files · read_file · search_code · find_symbol
 │    edit_file · write_file · show_staged_changes · discard_staged · submit_changes · run_command
 ├─ Changeset: staged edits held in memory, never on disk until reviewed
 ├─ Review controller: virtual-document diff editors, per-hunk CodeLens, panel review card
 ├─ Context engine: symbol index, BM25, import graph, token budget
 └─ Webview panel: streamed transcript, context card, subagent threads, review, undo
```

The extension never calls a model provider. Every model call goes through TrueForge, and the agent (not the extension) decides what to read and change, through the MCP tools.

Agent definitions are in [`agent/`](agent):

- `forgepilot-coder.json`: agent mode. It uses the editor MCP server, with `submit_changes` gated by TrueForge tool approval. Core tools are preloaded and the rest are deferred (deferred tool loading). Dynamic subagents and context compaction are on.
- `forgepilot-inline.json`: inline edit. It has no tools and returns one fenced replacement block.

On startup the extension saves both definitions to TrueForge as named agents. Each run creates a session from the definition, with the model filled in from your model order.

## Setup from a clean clone

Requirements: Node.js 22.14 or newer, VS Code 1.90 or newer, git.

```bash
git clone https://github.com/kevinmathew47/forgepilot.git
cd forgepilot
npm install
npm run build
```

### 1. Start TrueForge locally

```bash
bash scripts/start-trueforge.sh
```

On Windows PowerShell, run `scripts\start-trueforge.ps1` instead.

This runs `npx @truefoundry/trueforge@latest` in local mode on http://localhost:8790 with its SQLite data in `.trueforge/`. It also sets `OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1","localhost"]`. TrueForge's SSRF guard blocks loopback addresses by default, and both the editor MCP server and a local Ollama model live on localhost.

### 2. Configure models in TrueForge

Either use the TrueForge UI (Settings → Models), or copy the example configuration and run the script:

```bash
cp config/models.example.json config/models.json
cp .env.example .env
node scripts/configure-models.mjs
```

Put your keys in `.env` first. `config/models.json` and `.env` are git-ignored. Any catalog provider or OpenAI-compatible endpoint works.

### 3. Run the extension

Open this folder in VS Code and press `F5`. Or run the following, then open the target repository in the Extension Development Host window:

```bash
code --extensionDevelopmentPath=. path/to/your/repo
```

The status bar shows `TrueForge · primary → fallback`. Choose models with **ForgePilot: Select Models** or the panel's **Models** button. You can also set `forgepilot.models` to an ordered list of TrueForge model names such as `["google-gemini/gemini-3-5-flash-lite", "google-gemini/gemini-3-5-flash", "ollama/qwen2-5-7b"]`. The first model is primary and the rest are automatic fallbacks. With no setting, every model configured in TrueForge is used in order.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `forgepilot.trueforgeUrl` | `http://localhost:8790` | TrueForge server |
| `forgepilot.models` | `[]` | Ordered model names: primary, then fallbacks |
| `forgepilot.mcpPort` | `8791` | Port for the editor MCP server |
| `forgepilot.contextBudgetTokens` | `6000` | Budget for automatically retrieved context |
| `forgepilot.retryAttempts` | `2` | Retries with backoff per model on transient errors |
| `forgepilot.allowedCommands` | `pytest`, `python`, … | Commands the agent may run without a confirmation prompt |

## Keybindings

| Key | Action |
|---|---|
| `Ctrl+Alt+K` | Inline edit the selection (or the enclosing function when nothing is selected) |
| `Ctrl+Alt+Y` / `Ctrl+Alt+N` | Accept / reject the hunk at the cursor during review |
| `Ctrl+Alt+Enter` | Apply review decisions |
| `Ctrl+Alt+X` | Cancel the running generation |

## Testing

`test/` holds a VS Code integration harness that drives the real extension in a separate VS Code profile, against a live TrueForge:

```bash
FP_SCENARIO=taskA FP_MODELS=google-gemini/gemini-3-5-flash-lite node test/run.js
FP_SCENARIO=taskB FP_MODELS=google-gemini/gemini-3-5-flash-lite,google-gemini/gemini-3-5-flash node test/run.js
FP_SCENARIO=taskC FP_MODELS=openai/gpt-4-1-mini,google-gemini/gemini-3-5-flash-lite node test/run.js
FP_SCENARIO=cancel node test/run.js
```

On Windows, if the path contains spaces, run it from a junction without spaces and set `FP_EXT` and `FP_WORKSPACE`.

### Results on pallets/flask 3.1.3 (22d92470)

| Scenario | Result |
|---|---|
| Task A, inline edit | Diff streamed in ~5 s; 2 hunks accepted per hunk; `FLASK_DEBUG=off`, `OFF`, `n`, `no`, `false` and `0` all give `False`; undo restored a clean `git status` |
| Task B, agent mode | The agent found and edited `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst` unprompted, over 4 review rounds; `pytest tests/test_cli.py` gives 59 passed; `flask --help` lists `config`; secrets print as `"***"` ([diff](docs/taskB-result.diff)) |
| Task C, invalid key then fallback | 401 from the invalid key, automatic switch to the next model, correct edit, `git status` clean throughout |
| Task C, invalid key only | Clear error in ~1 s, editor responsive, `git status` clean |
| Cancel mid-stream | Stopped in ~130 ms, review closed, `git status` clean |

`examples/demoapp/app.py` is a small Flask app with secret-looking config keys, used to show `flask config` masking. The step-by-step recording plan is in [docs/VIDEO_SCRIPT.md](docs/VIDEO_SCRIPT.md).

## Loading the agent definition

There is nothing to import by hand. When the extension connects, it does three things:

1. It registers its MCP server in TrueForge as `forgepilot-editor` (`PUT /api/v1/settings/mcp-servers`).
2. It saves `agent/forgepilot-coder.json` and `agent/forgepilot-inline.json` as named TrueForge agents, using your primary model. You can see them under **Agents** in the TrueForge UI.
3. For each request it creates a session from the same definition with the active model filled in. This is how fallback can switch models without editing the saved agent.

Open any run in the TrueForge UI with the panel's **Session ↗** button (`http://localhost:8790/sessions/<id>`). That page shows the turns, tool calls, subagent threads and token usage.

## Credits

Third-party packages, used under their licences: [`@truefoundry/trueforge-sdk`](https://www.npmjs.com/package/@truefoundry/trueforge-sdk) (MIT), [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) (MIT), [`diff`](https://www.npmjs.com/package/diff) (BSD-3-Clause), [`zod`](https://www.npmjs.com/package/zod) (MIT). The harness is [TrueForge](https://github.com/truefoundry/trueforge) (MIT), run unmodified in local mode.

## Licence

MIT. See [LICENSE](LICENSE).
