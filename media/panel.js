(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const btn = (label, cls, onClick, title) => {
    const b = el("button", cls, label);
    if (title) b.title = title;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onClick();
    });
    return b;
  };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function md(src) {
    const parts = src.split(/```/);
    let html = "";
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf("\n");
        const code = nl >= 0 ? part.slice(nl + 1) : part;
        html += `<pre class="code"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
        return;
      }
      const lines = esc(part).split("\n");
      let inList = false;
      for (const raw of lines) {
        let line = raw
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
        if (li) {
          if (!inList) {
            html += "<ul>";
            inList = true;
          }
          html += `<li>${li[2]}</li>`;
          continue;
        }
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        const h = line.match(/^(#{1,4})\s+(.*)/);
        if (h) html += `<div class="h">${h[2]}</div>`;
        else if (line.trim()) html += `<p>${line}</p>`;
      }
      if (inList) html += "</ul>";
    });
    return html;
  }

  const header = el("div", "header");
  const status = el("div", "status");
  const dot = el("span", "dot off");
  const chain = el("span", "chain", "connecting…");
  status.append(dot, chain);
  const actions = el("div", "actions");
  const sessionBtn = btn("Session ↗", "ghost", () => vscode.postMessage({ type: "openSession" }), "Open this run in the TrueForge UI");
  sessionBtn.disabled = true;
  const undoBtn = btn("Undo last", "ghost", () => vscode.postMessage({ type: "undo" }), "Revert the last change ForgePilot applied");
  undoBtn.disabled = true;
  actions.append(
    btn("Models", "ghost", () => vscode.postMessage({ type: "pickModels" }), "Choose primary and fallback models configured in TrueForge"),
    sessionBtn,
    undoBtn,
    btn("New", "ghost", () => vscode.postMessage({ type: "newChat" }), "Start a new TrueForge session"),
  );
  header.append(status, actions);

  const log = el("div", "log");
  const empty = el("div", "empty");
  empty.innerHTML =
    "<div class='title'>ForgePilot agent</div><p>Describe a change. The agent finds the files itself, stages edits, and asks you to review every hunk before anything touches disk.</p><p>Use <code>@path/to/file.py</code> or <code>@SymbolName</code> to pin context. Inline edit: select code and press <code>Ctrl+Alt+K</code>.</p>";
  log.append(empty);

  const stagedBar = el("div", "staged hidden");
  const reviewBox = el("div", "review hidden");

  const composer = el("div", "composer");
  const ta = el("textarea");
  ta.placeholder = "Ask ForgePilot to change the code… (@ to mention a file or symbol)";
  ta.rows = 3;
  const sendBtn = btn("Send", "primary", () => submit());
  const suggest = el("div", "suggest hidden");
  composer.append(suggest, ta, sendBtn);

  app.append(header, log, stagedBar, reviewBox, composer);

  let running = false;
  let atBottom = true;
  log.addEventListener("scroll", () => {
    atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  });
  const scroll = () => {
    if (atBottom) log.scrollTop = log.scrollHeight;
  };
  const add = (node) => {
    if (empty.parentNode) empty.remove();
    log.append(node);
    scroll();
    return node;
  };

  function submit() {
    if (running) {
      vscode.postMessage({ type: "stop" });
      return;
    }
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    hideSuggest();
    vscode.postMessage({ type: "send", text });
  }

  ta.addEventListener("keydown", (e) => {
    if (!suggest.classList.contains("hidden")) {
      const items = [...suggest.children];
      const idx = items.findIndex((x) => x.classList.contains("sel"));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = e.key === "ArrowDown" ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
        items.forEach((x, i) => x.classList.toggle("sel", i === next));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && idx >= 0) {
        e.preventDefault();
        items[idx].click();
        return;
      }
      if (e.key === "Escape") {
        hideSuggest();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  let completeTimer;
  ta.addEventListener("input", () => {
    const m = ta.value.slice(0, ta.selectionStart).match(/(^|\s)@([\w./\\-]*)$/);
    clearTimeout(completeTimer);
    if (!m) return hideSuggest();
    completeTimer = setTimeout(() => vscode.postMessage({ type: "complete", q: m[2] }), 120);
  });
  function hideSuggest() {
    suggest.classList.add("hidden");
    suggest.innerHTML = "";
  }
  function showSuggest(items) {
    suggest.innerHTML = "";
    if (!items.length) return hideSuggest();
    items.forEach((it, i) => {
      const row = el("div", "item" + (i === 0 ? " sel" : ""));
      row.append(el("span", "kind " + it.kind, it.kind), el("span", "label", it.label));
      if (it.detail) row.append(el("span", "detail", it.detail));
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos).replace(/@([\w./\\-]*)$/, "@" + it.label + " ");
        ta.value = before + ta.value.slice(pos);
        ta.selectionStart = ta.selectionEnd = before.length;
        hideSuggest();
        ta.focus();
      });
      row.addEventListener("click", () => row.dispatchEvent(new MouseEvent("mousedown")));
      suggest.append(row);
    });
    suggest.classList.remove("hidden");
  }

  const messages = new Map();
  const threads = new Map();
  const calls = new Map();
  let pendingRender = new Set();
  function renderSoon(id) {
    pendingRender.add(id);
    requestAnimationFrame(() => {
      for (const k of pendingRender) {
        const m = messages.get(k);
        if (m) m.body.innerHTML = md(m.text) + (running && m.live ? "<span class='caret'></span>" : "");
      }
      pendingRender = new Set();
      scroll();
    });
  }

  function container(thread) {
    if (!thread || thread === "main") return null;
    return threads.get(thread)?.body ?? null;
  }

  function msgStart(d) {
    if (messages.has(d.id)) return;
    const box = el("div", "msg assistant");
    const body = el("div", "body");
    box.append(body);
    const parent = container(d.thread);
    if (parent) parent.append(box);
    else add(box);
    messages.set(d.id, { box, body, text: "", live: true });
  }

  function threadCard(d) {
    const card = el("details", "card thread");
    card.open = true;
    const sum = el("summary");
    sum.append(el("span", "badge sub", "subagent"), el("span", "ttl", d.title), el("span", "state", "running…"));
    const task = el("div", "task", (d.task || "").slice(0, 400));
    const body = el("div", "tbody");
    card.append(sum, task, body);
    add(card);
    threads.set(d.thread, { card, body, state: sum.querySelector(".state") });
  }

  function toolCall(d) {
    const row = el("details", "tool");
    const sum = el("summary");
    const name = el("span", "tname", d.name);
    sum.append(el("span", "ico", "⚙"), name, el("span", "targs", d.args || ""));
    const res = el("pre", "tres", "running…");
    row.append(sum, res);
    const parent = container(d.thread);
    if (parent) parent.append(row);
    else add(row);
    calls.set(d.callId, { row, res, name });
  }

  function contextCard(d) {
    const card = el("div", "card context");
    const head = el("div", "chead");
    head.append(el("span", "badge ctx", "context"), el("span", "ttl", `Chosen ${d.files.length} of ${d.considered} matching files · ${d.used.toLocaleString()} / ${d.budget.toLocaleString()} tokens`));
    const bar = el("div", "bar");
    const fill = el("div", "fill");
    fill.style.width = Math.min(100, Math.round((d.used / d.budget) * 100)) + "%";
    bar.append(fill);
    const q = el("div", "query", "for: " + d.query.slice(0, 200));
    const table = el("div", "files");
    d.files.forEach((f, i) => {
      const row = el("div", "frow");
      const top = el("div", "ftop");
      const link = el("a", "path", `${i + 1}. ${f.path}`);
      link.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: f.path, line: f.chunks[0]?.start }));
      top.append(link, el("span", "role " + f.role, f.role), el("span", "tok", `${f.tokens} tok`), el("span", "score", `score ${f.score}`));
      row.append(top, el("div", "why", "why: " + f.reasons.join("; ")));
      if (f.chunks.length) row.append(el("div", "chunks", "excerpts: " + f.chunks.map((c) => `${c.symbol} (${c.start}-${c.end})`).join(", ")));
      table.append(row);
    });
    card.append(head, bar, q, table);
    if (d.omitted?.length) card.append(el("div", "omitted", "left out (over budget or lower score): " + d.omitted.map((o) => o.path).join(", ")));
    const parent = container(d.thread);
    if (parent) parent.append(card);
    else add(card);
  }

  function notice(level, text) {
    add(el("div", "notice " + level, text));
  }

  function renderReview(r) {
    reviewBox.innerHTML = "";
    if (!r) {
      reviewBox.classList.add("hidden");
      return;
    }
    reviewBox.classList.remove("hidden");
    const head = el("div", "rhead");
    const total = r.files.reduce((n, f) => n + f.hunks.length, 0);
    const pending = r.files.reduce((n, f) => n + f.hunks.filter((h) => h.state === "pending").length, 0);
    head.append(el("span", "badge rev", r.streaming ? "streaming" : "review"), el("span", "ttl", `${r.title} · ${total} hunk(s), ${pending} pending`));
    reviewBox.append(head);
    const list = el("div", "rfiles");
    for (const f of r.files) {
      const fh = el("div", "rfile");
      const link = el("a", "path", `${f.path}${f.isNew ? " (new file)" : ""}`);
      link.addEventListener("click", () => vscode.postMessage({ type: "openReviewFile", path: f.path }));
      fh.append(link, el("span", "add", `+${f.added}`), el("span", "del", `-${f.removed}`));
      list.append(fh);
      for (const h of f.hunks) {
        const hb = el("div", "hunk " + h.state);
        const hh = el("div", "hhead");
        hh.append(el("span", "", `Hunk ${h.id + 1} · line ${h.origStart} · +${h.added} -${h.removed}`));
        if (!r.streaming) {
          if (h.state === "pending") {
            hh.append(
              btn("✓ Accept", "ok", () => vscode.postMessage({ type: "hunk", path: f.path, id: h.id, state: "accepted" })),
              btn("✗ Reject", "no", () => vscode.postMessage({ type: "hunk", path: f.path, id: h.id, state: "rejected" })),
            );
          } else {
            hh.append(el("span", "verdict " + h.state, h.state), btn("↺", "ghost", () => vscode.postMessage({ type: "hunk", path: f.path, id: h.id, state: "pending" }), "Undo this decision"));
          }
        }
        const pre = el("pre", "hdiff");
        for (const line of h.preview.split("\n")) pre.append(el("div", line.startsWith("+") ? "a" : line.startsWith("-") ? "d" : "", line));
        hb.append(hh, pre);
        list.append(hb);
      }
    }
    reviewBox.append(list);
    if (!r.streaming) {
      const foot = el("div", "rfoot");
      foot.append(
        btn("Accept all", "ok", () => vscode.postMessage({ type: "acceptAll" })),
        btn("Reject all", "no", () => vscode.postMessage({ type: "rejectAll" })),
        btn("Apply decisions", "primary", () => vscode.postMessage({ type: "apply" })),
      );
      reviewBox.append(foot);
    }
  }

  function setRunning(r) {
    running = r;
    sendBtn.textContent = r ? "■ Stop" : "Send";
    sendBtn.className = r ? "danger" : "primary";
    if (!r) {
      for (const m of messages.values()) {
        if (m.live) {
          m.live = false;
          m.body.innerHTML = md(m.text);
        }
      }
      for (const t of threads.values()) if (t.state.textContent === "running…") t.state.textContent = "stopped";
    }
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    switch (d.type) {
      case "models":
        dot.className = "dot " + (d.connected ? "on" : "off");
        chain.textContent = d.connected
          ? d.order.length
            ? d.order.map((m, i) => (i === 0 ? m : "→ " + m)).join(" ")
            : "no model configured in TrueForge"
          : "TrueForge offline (click Models after starting it)";
        chain.title = "Primary model first, then automatic fallbacks. All models are configured in TrueForge.";
        break;
      case "modelActive":
        chain.dataset.active = d.model;
        add(el("div", "model-line", `▶ ${d.model}${d.attempt > 1 ? ` · attempt ${d.attempt}` : ""}`));
        break;
      case "session":
        sessionBtn.disabled = false;
        add(el("div", "model-line", `TrueForge session ${d.id} · ${d.model}`));
        break;
      case "user": {
        const box = el("div", "msg user");
        box.append(el("div", "body", d.text));
        if (d.attachments?.length) {
          const att = el("div", "attach");
          d.attachments.forEach((a) => att.append(el("span", "chip " + a.kind, `📎 ${a.label} · ${a.tokens} tok`)));
          box.append(att);
        }
        add(box);
        atBottom = true;
        break;
      }
      case "running":
        setRunning(d.running);
        break;
      case "msgStart":
        msgStart(d);
        break;
      case "delta": {
        if (!messages.has(d.id)) msgStart(d);
        const m = messages.get(d.id);
        m.text += d.content;
        renderSoon(d.id);
        break;
      }
      case "toolCall":
        toolCall(d);
        break;
      case "toolResult": {
        const c = calls.get(d.callId);
        if (c) {
          c.res.textContent = d.content || "(empty)";
          if (d.isError) c.row.classList.add("err");
          c.row.classList.add("done");
        }
        break;
      }
      case "thread":
        threadCard(d);
        break;
      case "threadDone": {
        const t = threads.get(d.thread);
        if (t) {
          t.state.textContent = d.status;
          t.card.open = false;
        }
        break;
      }
      case "context":
        contextCard(d);
        break;
      case "staged":
        stagedBar.innerHTML = "";
        if (!d.files.length) stagedBar.classList.add("hidden");
        else {
          stagedBar.classList.remove("hidden");
          stagedBar.append(el("span", "badge stg", "staged, not on disk"));
          d.files.forEach((f) => stagedBar.append(el("span", "chip", `${f.path}${f.isNew ? " (new)" : ""} +${f.added} -${f.removed}`)));
        }
        break;
      case "review":
        renderReview(d.review);
        break;
      case "applied": {
        const card = el("div", "card applied");
        card.append(el("span", "badge ok", "applied"), el("span", "ttl", `${d.accepted} hunk(s) written to ${d.files.join(", ")}${d.rejected ? ` · ${d.rejected} rejected` : ""}`));
        card.append(btn("Undo", "ghost", () => vscode.postMessage({ type: "undo" })));
        add(card);
        break;
      }
      case "history":
        undoBtn.disabled = !d.size;
        undoBtn.title = d.last ? `Undo: ${d.last}` : "Nothing to undo";
        break;
      case "command": {
        const card = el("details", "card cmd " + (d.exitCode === 0 ? "pass" : "fail"));
        const sum = el("summary");
        sum.append(el("span", "badge term", "terminal"), el("span", "ttl", `$ ${d.command}`), el("span", "exit", `exit ${d.exitCode}`));
        card.append(sum, el("pre", "tres", d.output));
        add(card);
        break;
      }
      case "notice":
        notice(d.level, d.text);
        break;
      case "mcp":
        break;
      case "turnState":
        if (d.status === "paused") add(el("div", "model-line", "⏸ TrueForge paused the turn for your approval"));
        break;
      case "final": {
        const f = el("div", "final");
        const m = d.metrics || {};
        const parts = [];
        if (d.model) parts.push(d.model);
        if (m.totalTokens) parts.push(`${m.totalTokens.toLocaleString()} tokens`);
        if (m.totalCostInUsd !== undefined) parts.push(`$${Number(m.totalCostInUsd).toFixed(4)}`);
        f.textContent = "✔ done" + (parts.length ? " · " + parts.join(" · ") : "");
        add(f);
        break;
      }
      case "completions":
        showSuggest(d.items);
        break;
      case "openSessionRequest":
        vscode.postMessage({ type: "openSession" });
        break;
      case "reset":
        log.innerHTML = "";
        log.append(empty);
        messages.clear();
        threads.clear();
        calls.clear();
        sessionBtn.disabled = true;
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
