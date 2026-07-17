/* ============================================================================
 * BKR Solution — Live shared workspace
 * share.js
 *
 * Lets two (or more) people edit the SAME situation sheet from different
 * devices, live. Built on Firebase Firestore (free tier):
 *
 *   • One-time setup: the owner creates a free Firebase project and pastes
 *     its config here (stored in this browser only).
 *   • "Create workspace" makes a random 8-character code and uploads the
 *     current sheet to  workspaces/<CODE>  in Firestore.
 *   • A friend taps "Join", types the code, and from then on both devices
 *     listen to that document: every local edit is pushed (debounced), and
 *     every remote change is applied to the sheet immediately.
 *
 * Conflict model: last write wins — fine for a small team taking turns.
 * The sheet itself still works fully offline/local when not in a workspace.
 * ========================================================================== */
(function () {
  "use strict";

  const CONFIG_KEY = "bkr-fb-config";   // pasted Firebase config (this browser)
  const ROOM_KEY   = "bkr-ws-code";     // workspace we're currently in
  const PUSH_DELAY = 700;               // ms of quiet typing before we upload

  // A random id for this browser tab, so we can ignore our own echoes.
  const clientId = "c_" + Math.random().toString(36).slice(2, 10);

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    setup: $("shareSetup"), idle: $("shareIdle"), live: $("shareLive"),
    configInput: $("fbConfigInput"), configSave: $("fbConfigSaveBtn"), setupMsg: $("shareSetupMsg"),
    createBtn: $("wsCreateBtn"), joinInput: $("wsJoinInput"), joinBtn: $("wsJoinBtn"),
    idleMsg: $("shareIdleMsg"), reconfig: $("fbReconfigBtn"),
    codeLabel: $("wsCodeLabel"), status: $("shareStatus"), dot: $("shareDot"),
    copyBtn: $("wsCopyBtn"), leaveBtn: $("wsLeaveBtn"),
  };

  /* ---------- state ---------- */
  let db = null;          // Firestore instance
  let unsubscribe = null; // active snapshot listener
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

  /**
   * Parse whatever the user pasted from the Firebase console into an object.
   * Accepts plain JSON or the usual `const firebaseConfig = { … };` snippet.
   */
  function parseConfig(text) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Couldn't find a { … } block in what you pasted.");
    let obj;
    try {
      obj = JSON.parse(m[0]);
    } catch (e) {
      try {
        obj = new Function("return (" + m[0] + ")")();   // tolerate JS-style keys
      } catch (e2) {
        throw new Error("That doesn't look like a valid Firebase config.");
      }
    }
    if (!obj || !obj.apiKey || !obj.projectId) {
      throw new Error("The config needs at least apiKey and projectId.");
    }
    return obj;
  }

  /* ---------- Firebase lifecycle ---------- */
  function initFirebase() {
    if (db) return true;
    const raw = store.get(CONFIG_KEY);
    if (!raw) return false;
    try {
      const cfg = JSON.parse(raw);
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      db = firebase.firestore();
      return true;
    } catch (e) {
      console.error("Firebase init failed:", e);
      return false;
    }
  }

  function docRef(code) { return db.collection("workspaces").doc(code); }

  /** Start listening to a workspace document and mirror it into the sheet. */
  function connect(code) {
    disconnect();
    room = code;
    store.set(ROOM_KEY, code);
    els.codeLabel.textContent = code;
    show("live");
    setStatus("Connecting…");

    unsubscribe = docRef(code).onSnapshot(
      (snap) => {
        const data = snap.data();
        if (!data || !data.json) { setStatus("Synced · empty workspace", "ok"); return; }
        setStatus("Synced", "ok");
        if (data.client === clientId) return;          // our own write echoed back
        if (data.json === lastPushedJson) return;      // nothing actually new
        try {
          const remote = JSON.parse(data.json);
          lastPushedJson = data.json;                  // remember so we don't re-push it
          window.BKRSheet.applyRemote(remote);
        } catch (e) {
          console.error("Bad workspace data:", e);
        }
      },
      (err) => {
        console.error("Workspace listener error:", err);
        setStatus(err.code === "permission-denied"
          ? "Blocked — check the Firestore rules (step 3)."
          : "Connection problem — retrying…", "err");
      }
    );
  }

  function disconnect() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    room = null;
    clearTimeout(pushTimer);
  }

  /** Debounced upload of the current sheet to the workspace document. */
  function schedulePush(state) {
    if (!db || !room) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      const json = JSON.stringify(state);
      if (json === lastPushedJson) return;             // no real change
      lastPushedJson = json;
      setStatus("Saving…");
      docRef(room).set({
        json,
        client: clientId,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }).then(() => setStatus("Synced", "ok"))
        .catch((err) => {
          console.error("Push failed:", err);
          setStatus(err.code === "permission-denied"
            ? "Blocked — check the Firestore rules (step 3)."
            : "Couldn't save — will retry on next edit.", "err");
        });
    }, PUSH_DELAY);
  }

  // Hook: sheet.js calls this on every local edit.
  window.BKRSheet.onLocalChange = (state) => {
    if (window.BKRSheet._applying) return;             // change came FROM remote
    schedulePush(state);
  };

  /* ---------- wire up the panel ---------- */
  els.configSave.addEventListener("click", () => {
    try {
      const cfg = parseConfig(els.configInput.value);
      store.set(CONFIG_KEY, JSON.stringify(cfg));
      db = null;
      if (!initFirebase()) throw new Error("Firebase couldn't start with that config.");
      msg(els.setupMsg, "");
      show("idle");
      msg(els.idleMsg, "Sharing enabled ✓");
    } catch (e) {
      msg(els.setupMsg, e.message, true);
    }
  });

  els.createBtn.addEventListener("click", () => {
    if (!initFirebase()) { show("setup"); return; }
    const code = newCode();
    connect(code);
    // Seed the workspace with whatever is on screen right now.
    schedulePush(window.BKRSheet.get());
    // Show the code prominently so it can be sent to the friend.
    msg(els.idleMsg, "");
    try { navigator.clipboard && navigator.clipboard.writeText(code); } catch (e) { /* ignore */ }
  });

  els.joinBtn.addEventListener("click", () => {
    if (!initFirebase()) { show("setup"); return; }
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
      try { els.configInput.value = JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { /* ignore */ }
    }
    show("setup");
  });

  /* ---------- boot ---------- */
  if (typeof firebase === "undefined") {
    // Firebase script failed to load (very locked-down browser). Hide the
    // whole panel rather than show controls that can't work.
    $("sharePanel").hidden = true;
    return;
  }
  if (!store.get(CONFIG_KEY)) {
    show("setup");
  } else if (initFirebase()) {
    const savedRoom = store.get(ROOM_KEY);
    if (savedRoom) connect(savedRoom);   // rejoin where we left off
    else show("idle");
  } else {
    show("setup");
  }
})();
