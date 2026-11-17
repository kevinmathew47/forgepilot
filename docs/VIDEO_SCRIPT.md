# Demo video script (4 minutes max)

The PDF requires Tasks A, B and C in that order, each followed by its on-screen verification, and a brief view of the TrueForge session during Task B. Waiting time may be shortened, but never cut between giving an instruction and the diff appearing. Speed up long waits (for example 4–8×) with a visible "sped up" caption instead of cutting.

## Before recording

1. Start TrueForge and leave it running: `bash scripts/start-trueforge.sh` (or `scripts\start-trueforge.ps1`).
2. Reset Flask to the pinned tag:
   ```bash
   cd "D:/IIT bombay/flask" && git checkout -- . && git status
   ```
   It must show `nothing to commit, working tree clean`.
3. Open `forgepilot` in VS Code, press **F5**, and open the `flask` folder in the window that appears. Close every other ForgePilot window.
4. Status bar: `TrueForge · gemini-3-5-flash-lite → gemini-3-5-flash → qwen2-5-7b`. If it shows offline, run **ForgePilot: Reconnect**.
5. Open a terminal in VS Code at the Flask folder and activate the venv: `.venv\Scripts\activate`.
6. Wait a minute after any earlier test run so the Gemini free-tier per-minute limit has reset.
7. Use a large editor font (Ctrl + =) so diffs are readable in the recording.

## 0:00 – 0:10 · Title

On screen: the VS Code window with the ForgePilot panel open and the status bar showing the model chain. Caption: "ForgePilot: a coding agent on TrueForge. Flask 3.1.3 at 22d92470."

## 0:10 – 0:55 · Task A, inline edit

1. Open `src/flask/helpers.py` and select the whole `get_debug_flag` function (lines 28–33).
2. Press **Ctrl+Alt+K** and paste exactly:
   > Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
3. Show the diff tab filling in as tokens stream, then the **Accept / Reject** CodeLens on each hunk.
4. Click **Accept** on each hunk. Point out that the panel's review card mirrors the same hunks.
5. Verify in the terminal:
   ```powershell
   $env:FLASK_DEBUG="off"; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   It prints `False`.
6. Optional, for B2 (undo): click **Undo last** in the panel and show `git status` clean, then redo Task A or skip ahead. Better still, show undo after Task B, where it matters more.

## 0:55 – 2:50 · Task B, agent mode (no files named)

1. In the ForgePilot panel, with nothing mentioned, paste exactly:
   > Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "\*\*\*". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
2. Show the **Context** card: the files chosen (`src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`, …), the reason for each, and the token budget bar. Hold for about 3 seconds; this is the B1 evidence.
3. Show tool calls streaming (`read_file`, `edit_file` …) and the **staged, not on disk** bar.
4. If a rate-limit notice appears ("retrying in 37s"), keep it on screen briefly: it shows resilience. Speed up the wait.
5. When TrueForge pauses for approval, show the diff tabs for three files and click **Accept** per hunk (or **Accept all**). Mention that nothing touched disk until now.
6. If the agent runs tests and submits a follow-up fix, accept it the same way.
7. Click **Session ↗** and show the TrueForge session page (turns and tool calls). Include subagent threads if any appear. Hold for about 5 seconds.
8. Verify in the terminal:
   ```powershell
   python -m pytest tests/test_cli.py -q
   ```
   ```powershell
   cd ..\forgepilot\examples\demoapp; flask --help; flask --app app config
   ```
   Show the passing tests, `config` listed under Commands, and the JSON with `"***"` for `SECRET_KEY`, `DB_PASSWORD`, `API_TOKEN` and `STRIPE_KEY`.
9. Show `git diff --stat` in the Flask folder: 3 files changed.
10. For B2, click **Undo last** (or Ctrl+Z) on one change set and show the file revert.

## 2:50 – 3:40 · Task C, resilience

1. Reset Flask: `git checkout -- .` then `git status` (clean).
2. Run **ForgePilot: Select Models**. Pick `openai/gpt-4-1-mini` as primary (it is configured in TrueForge with an invalid key) and `google-gemini/gemini-3-5-flash-lite` as fallback. The status bar now shows `gpt-4-1-mini → gemini-3-5-flash-lite`.
3. Optional: show the provider in TrueForge Settings → Models with its key redacted.
4. Repeat Task A exactly: select `get_debug_flag`, press Ctrl+Alt+K, paste the same instruction.
5. Show the panel notice "openai/gpt-4-1-mini failed: … 401 Incorrect API key … Falling back to google-gemini/gemini-3-5-flash-lite automatically", and that the editor stays responsive (scroll or type in another file).
6. Click **Reject all** (or just stop here) and run `git status` to show no files changed.
7. Optional second half: select only `openai/gpt-4-1-mini` and repeat. Show the clear error message and `git status` clean.

## 3:40 – 4:00 · Cancellation (A3) and close

1. Restore the model order (**Select Models** → `gemini-3-5-flash-lite`, …).
2. Start Task A again and, while tokens stream, press **Ctrl+Alt+X** (or click **Cancel** in the status bar).
3. Show that the diff closes, "cancelled, nothing changed" appears, and `git status` is clean.
4. End card: GitHub URL.

## Scorecard timestamps for the write-up

After recording, fill in the times in `docs/WRITEUP.md` section 6:

| Criterion | Where in the video |
|---|---|
| A1 Inline edit | Task A, per-hunk accept |
| A2 Agent mode | Task B, three files found unprompted |
| A3 Streaming and cancellation | Streaming in A/B, cancel at the end |
| B1 Context | Task B, Context card |
| B2 Diff safety | Task B review plus Undo |
| B3 Resilience | Task C fallback notice and `git status` |
| B4 TrueForge depth | Task B session page; approval pause driving review |
