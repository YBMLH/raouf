/* ============================================================================
 * BKR Solution — Live shared workspace
 * share.js
 *
 * Lets two (or more) people edit the SAME situation sheet from different
 * devices, live. Built on Supabase (Postgres + Realtime, free tier, no
 * credit card needed to sign up):
 *
 *   • One-time setup: the owner creates a free Supabase project, runs the
 *     provided SQL once, and pastes the project's URL + anon key here
 *     (stored in this browser only).
 *   • "Create workspace" makes a random 8-character code and upserts the
 *     current sheet into the `workspaces` table under that code.
 *   • A friend taps "Join", types the code, and from then on both devices
 *     subscribe to Postgres changes on that row: every local edit is
 *     pushed (debounced), and every remote change is applied to the sheet
 *     immediately.
 *
 * Conflict model: last write wins — fine for a small team taking turns.
 * The sheet itself still works fully offline/local when not in a workspace.
 * ========================================================================== */
(function () {
  "use strict";

  const CONFIG_KEY = "bkr-sb-config";   // { url, key } pasted from Supabase (this browser)
  const ROOM_KEY    = "bkr-ws-code";    // workspace we're currently in
  const PUSH_DELAY  = 700;              // ms of quiet typing before we upload

  // A random id for this browser tab, so we can ignore our own echoes.
  const clientId = "c_" + Math.random().toString(36).slice(2, 10);

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    setup: $("shareSetup"), idle: $("shareIdle"), live: $("shareLive"),
    urlInput: $("sbUrlInput"), keyInput: $("sbKeyInput"), configSave: $("sbConfigSaveBtn"), setupMsg: $("shareSetupMsg"),
    createBtn: $("wsCreateBtn"), joinInput: $("wsJoinInput"), joinBtn: $("wsJoinBtn"),
    idleMsg: $("shareIdleMsg"), reconfig: $("sbReconfigBtn"),
    codeLabel: $("wsCodeLabel"), status: $("shareStatus"), dot: $("shareDot"),
    copyBtn: $("wsCopyBtn"), leaveBtn: $("wsLeaveBtn"),
  };

  /* ---------- state ---------- */
  let client = null;      // Supabase client instance
  let channel = null;     // active realtime channel
  let room = null;        // current workspace code
  let pushTimer = null;
  let lastPushedJson = "";

  /* ---------- helpers ---------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  function show(panel) {
    els.setup.hidden = panel !== "setup";
    els.idle.hidden = panel !== "idle";
    els.live.hidden = panel !== "live";
  }
  function setStatus(text, kind) {
    els.status.textContent = text;
    els.dot.className = "share-live-dot" + (kind ? " " + kind : "");
  }
  function msg(el, text, isError) {
    el.textContent = text;
    el.classList.toggle("err", !!isError);
    if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 6000);
  }

  // Codes avoid look-alike characters (0/O, 1/I/L) for easy phone typing.
  function newCode() {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let c = "";
    for (let i = 0; i < 8; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }

  /* ---------- Supabase lifecycle ---------- */
  function initClient() {
    if (client) return true;
    const raw = store.get(CONFIG_KEY);
    if (!raw) return false;
    try {
      const cfg = JSON.parse(raw);
      if (!cfg.url || !cfg.key) return false;
      client = supabase.createClient(cfg.url, cfg.key);
      return true;
    } catch (e) {
      console.error("Supabase init failed:", e);
      return false;
    }
  }

  function friendlyDbError(err) {
    const m = (err && (err.message || err.error_description || err.hint)) || "";
    if (/relation .* does not exist/i.test(m)) return "The workspaces table doesn't exist yet — run the SQL from step 2.";
    if (/permission denied|row-level security|RLS/i.test(m)) return "Blocked by row-level security — check the SQL policy from step 2.";
    if (/JWT|Invalid API key|apikey/i.test(m)) return "Invalid Project URL or anon key — check step 3.";
    return m || "Connection problem — retrying on next edit.";
  }

  /** Start listening to a workspace row and mirror it into the sheet. */
  async function connect(code) {
    disconnect();
    room = code;
    store.set(ROOM_KEY, code);
    els.codeLabel.textContent = code;
    show("live");
    setStatus("Connecting…");

    // 1) Fetch whatever is already there (realtime only pushes on CHANGE).
    try {
      const { data, error } = await client.from("workspaces").select("json,client").eq("code", code).maybeSingle();
      if (error) throw error;
      if (data && data.json) {
        lastPushedJson = data.json;
        try { window.BKRSheet.applyRemote(JSON.parse(data.json)); } catch (e) { /* ignore bad row */ }
      }
      setStatus("Synced", "ok");
    } catch (err) {
      console.error("Initial fetch failed:", err);
      setStatus(friendlyDbError(err), "err");
    }

    // 2) Subscribe to live changes on this row.
    channel = client
      .channel("workspace:" + code)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "workspaces", filter: `code=eq.${code}` },
        (payload) => {
          const row = payload.new;
          if (!row || !row.json) return;
          if (row.client === clientId) return;          // our own write echoed back
          if (row.json === lastPushedJson) return;       // nothing actually new
          try {
            lastPushedJson = row.json;                   // remember so we don't re-push it
            window.BKRSheet.applyRemote(JSON.parse(row.json));
            setStatus("Synced", "ok");
          } catch (e) {
            console.error("Bad workspace data:", e);
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setStatus("Synced", "ok");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setStatus("Connection problem — retrying…", "err");
      });
  }

  function disconnect() {
    if (channel) { client && client.removeChannel(channel); channel = null; }
    room = null;
    clearTimeout(pushTimer);
  }

  /** Debounced upsert of the current sheet into the workspace row. */
  function schedulePush(state) {
    if (!client || !room) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      const json = JSON.stringify(state);
      if (json === lastPushedJson) return;              // no real change
      lastPushedJson = json;
      setStatus("Saving…");
      try {
        const { error } = await client.from("workspaces").upsert({
          code: room, json, client: clientId, updated_at: new Date().toISOString(),
        });
        if (error) throw error;
        setStatus("Synced", "ok");
      } catch (err) {
        console.error("Push failed:", err);
        setStatus(friendlyDbError(err), "err");
      }
    }, PUSH_DELAY);
  }

  // Hook: sheet.js calls this on every local edit.
  window.BKRSheet.onLocalChange = (state) => {
    if (window.BKRSheet._applying) return;               // change came FROM remote
    schedulePush(state);
  };

  /* ---------- wire up the panel ---------- */
  els.configSave.addEventListener("click", () => {
    const url = els.urlInput.value.trim();
    const key = els.keyInput.value.trim();
    if (!/^https:\/\/.+\.supabase\.co/i.test(url)) { msg(els.setupMsg, "That doesn't look like a Supabase project URL.", true); return; }
    if (key.length < 20) { msg(els.setupMsg, "That doesn't look like a valid anon key.", true); return; }
    store.set(CONFIG_KEY, JSON.stringify({ url, key }));
    client = null;
    if (!initClient()) { msg(els.setupMsg, "Couldn't start Supabase with that config.", true); return; }
    msg(els.setupMsg, "");
    show("idle");
    msg(els.idleMsg, "Sharing enabled ✓");
  });

  els.createBtn.addEventListener("click", async () => {
    if (!initClient()) { show("setup"); return; }
    const code = newCode();
    await connect(code);
    // Seed the workspace with whatever is on screen right now.
    schedulePush(window.BKRSheet.get());
    msg(els.idleMsg, "");
    try { navigator.clipboard && navigator.clipboard.writeText(code); } catch (e) { /* ignore */ }
  });

  els.joinBtn.addEventListener("click", () => {
    if (!initClient()) { show("setup"); return; }
    const code = els.joinInput.value.trim().toUpperCase();
    if (code.length < 4) { msg(els.idleMsg, "Enter the workspace code first.", true); return; }
    connect(code);
  });
  els.joinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") els.joinBtn.click(); });

  els.copyBtn.addEventListener("click", () => {
    const code = els.codeLabel.textContent;
    const done = () => { els.copyBtn.textContent = "Copied ✓"; setTimeout(() => (els.copyBtn.textContent = "Copy code"), 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(done).catch(done);
    else done();
  });

  els.leaveBtn.addEventListener("click", () => {
    disconnect();
    store.del(ROOM_KEY);
    show("idle");
  });

  els.reconfig.addEventListener("click", () => {
    const raw = store.get(CONFIG_KEY);
    if (raw) {
      try {
        const cfg = JSON.parse(raw);
        els.urlInput.value = cfg.url || "";
        els.keyInput.value = cfg.key || "";
      } catch (e) { /* ignore */ }
    }
    show("setup");
  });

  /* ---------- boot ---------- */
  if (typeof supabase === "undefined") {
    // The library failed to load (very locked-down browser). Hide the
    // whole panel rather than show controls that can't work.
    $("sharePanel").hidden = true;
    return;
  }
  if (!store.get(CONFIG_KEY)) {
    show("setup");
  } else if (initClient()) {
    const savedRoom = store.get(ROOM_KEY);
    if (savedRoom) connect(savedRoom);   // rejoin where we left off
    else show("idle");
  } else {
    show("setup");
  }
})();
