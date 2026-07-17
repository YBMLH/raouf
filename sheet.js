/* ============================================================================
 * Papercut — Situation Sheet builder
 * sheet.js
 *
 * A second tool living in the same page: it recreates the "Cars in the Sea"
 * situation sheet so you can fill it in and print it exactly like the original
 * spreadsheet (or Save as PDF from the browser's print dialog).
 *
 * Layout faithfully mirrors the Excel file:
 *   • A grey SECTION header  (Line / Carrier · Port · Date)   ← "+ Add section"
 *   • A "Fournisseur" line    (new field you asked for)
 *   • The 14 original columns: N°, Name Client, Car, COLOR, VIN Number,
 *     BL Number, Container, Seal, Port, Transit, Case Status, Receipt,
 *     Payment notice Customs, Customs Duty Payment
 *   • CONTAINER BLOCKS whose Car / COLOR / Container / Seal are shared
 *     (merged) across the block's car rows, exactly like the spreadsheet.
 *
 * Everything is kept in a small state object, mirrored to localStorage so a
 * refresh doesn't lose your work. No servers, no uploads.
 * ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Column definitions (order matches the original spreadsheet)
   *   shared: true  → one merged cell for the whole container block
   *                   (Car, COLOR, Container, Seal)
   *   shared: false → a value per car row
   * ------------------------------------------------------------------ */
  const COLUMNS = [
    { key: "num",       label: "N°",                    shared: false, auto: true },
    { key: "name",      label: "Name Client",           shared: false },
    { key: "car",       label: "Car",                   shared: true  },
    { key: "color",     label: "COLOR",                 shared: true  },
    { key: "vin",       label: "VIN Number",            shared: false },
    { key: "bl",        label: "BL Number",             shared: false },
    { key: "container", label: "Container",             shared: true  },
    { key: "seal",      label: "Seal",                  shared: true  },
    { key: "port",      label: "Port",                  shared: false },
    { key: "transit",   label: "Transit",               shared: false },
    { key: "status",    label: "Case Status",           shared: false },
    { key: "receipt",   label: "Receipt",               shared: false },
    { key: "notice",    label: "Payment notice Customs", shared: false },
    { key: "duty",      label: "Customs Duty Payment",  shared: false },
  ];
  const COLSPAN = COLUMNS.length;            // 14 — used by full-width rows
  const ROW_KEYS = COLUMNS.filter((c) => !c.shared && !c.auto).map((c) => c.key);
  const SHARED_KEYS = COLUMNS.filter((c) => c.shared).map((c) => c.key);
  const STORAGE_KEY = "papercut-sheet";

  /* ------------------------------------------------------------------ *
   * DOM references
   * ------------------------------------------------------------------ */
  const sheetDoc      = document.getElementById("sheetDoc");
  const docTitleInput = document.getElementById("docTitle");
  const addSectionBtn = document.getElementById("addSectionBtn");
  const clearSheetBtn = document.getElementById("clearSheetBtn");
  const printSheetBtn = document.getElementById("printSheetBtn");

  /* ------------------------------------------------------------------ *
   * State + factories
   * ------------------------------------------------------------------ */
  function newRow()   { const r = {}; ROW_KEYS.forEach((k) => (r[k] = "")); return r; }
  function newBlock(rows) {
    const b = {}; SHARED_KEYS.forEach((k) => (b[k] = ""));
    b.rows = Array.from({ length: rows || 4 }, newRow);   // spreadsheet uses 4 cars/container
    return b;
  }
  function newSection() {
    return { carrier: "", port: "", date: "", fournisseur: "", blocks: [newBlock()] };
  }
  function defaultState() {
    return { title: "SITUATION CARS IN THE SEA", sections: [newSection()] };
  }

  let state = load() || defaultState();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sections)) return parsed;
    } catch (e) { /* ignore corrupt/blocked storage */ }
    return null;
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  // Escape user text so it is safe inside HTML attributes / cells.
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  // A borderless cell input. `extra` carries data-* hooks used by the input handler.
  function cellInput(value, extra, placeholder) {
    return `<input class="sit-in" type="text" value="${esc(value)}" ` +
           `placeholder="${esc(placeholder || "")}" ${extra || ""} />`;
  }

  // Build the <colgroup> so columns keep sensible proportions and print tidily.
  const COL_WIDTHS = ["3%","15%","6%","6%","12%","9%","8%","7%","5%","6%","7%","5%","12%","12%"];
  function colgroup() {
    return "<colgroup>" + COL_WIDTHS.map((w) => `<col style="width:${w}">`).join("") + "</colgroup>";
  }

  function renderRow(section, sIdx, block, bIdx, row, rIdx, blockLen) {
    let html = `<tr data-ri="${rIdx}">`;
    for (const col of COLUMNS) {
      if (col.auto) {                                  // N° — auto 1..n within the block
        html += `<td class="c-num">${rIdx + 1}</td>`;
      } else if (col.shared) {
        // Shared columns only appear once per block (first row), spanning all rows.
        if (rIdx === 0) {
          html += `<td class="c-shared" rowspan="${blockLen}">` +
                  cellInput(block[col.key], `data-shared="${col.key}"`, col.label) + `</td>`;
        }
      } else {
        html += `<td>` + cellInput(row[col.key], `data-k="${col.key}"`, "") + `</td>`;
      }
    }
    html += `</tr>`;
    return html;
  }

  function renderBlock(section, sIdx, block, bIdx) {
    const len = block.rows.length;
    let rows = block.rows.map((r, rIdx) => renderRow(section, sIdx, block, bIdx, r, rIdx, len)).join("");
    // Per-block control strip (hidden when printing). Spans the full width so
    // it never disturbs column alignment.
    const ctrl =
      `<tr class="sit-block-ctrl no-print"><td colspan="${COLSPAN}">` +
        `<button class="mini-btn" data-act="add-row">＋ Add car</button>` +
        `<button class="mini-btn" data-act="del-row">− Remove last car</button>` +
        `<button class="mini-btn danger" data-act="del-block">🗑 Remove container</button>` +
      `</td></tr>`;
    return `<tbody class="sit-block" data-bi="${bIdx}">${rows}${ctrl}</tbody>`;
  }

  function renderSection(section, sIdx) {
    const head =
      `<tr class="sit-head">` +
        COLUMNS.map((c) => `<th>${esc(c.label)}</th>`).join("") +
      `</tr>`;

    const titleRow =
      `<tr class="sit-title"><th colspan="${COLSPAN}">` +
        `<div class="sit-title-fields">` +
          cellInput(section.carrier, `data-field="carrier"`, "Line / Carrier") +
          `<span class="sep">·</span>` +
          cellInput(section.port, `data-field="port"`, "Port") +
          `<span class="sep">·</span>` +
          cellInput(section.date, `data-field="date"`, "Date & time") +
        `</div>` +
      `</th></tr>`;

    const fournRow =
      `<tr class="sit-fourn"><th colspan="${COLSPAN}">` +
        `<span class="fourn-label">Fournisseur :</span>` +
        cellInput(section.fournisseur, `data-field="fournisseur"`, "Supplier name") +
      `</th></tr>`;

    const bodies = section.blocks.map((b, bIdx) => renderBlock(section, sIdx, b, bIdx)).join("");

    return (
      `<div class="sit-section" data-si="${sIdx}">` +
        `<div class="sit-section-controls no-print">` +
          `<span class="sit-section-tag">Section ${sIdx + 1}</span>` +
          `<button class="mini-btn" data-act="add-block">＋ Add container</button>` +
          `<button class="mini-btn danger" data-act="del-section">✕ Remove section</button>` +
        `</div>` +
        `<div class="sit-table-wrap">` +
          `<table class="sit-table">` + colgroup() +
            `<thead>${titleRow}${fournRow}${head}</thead>` +
            bodies +
          `</table>` +
        `</div>` +
      `</div>`
    );
  }

  function render() {
    docTitleInput.value = state.title || "";
    const title = state.title
      ? `<h2 class="sit-doc-title">${esc(state.title)}</h2>` : "";
    sheetDoc.innerHTML = title + state.sections.map(renderSection).join("");
    save();
  }

  /* ------------------------------------------------------------------ *
   * Editing — live-update the model as the user types (no re-render, so
   * the caret never jumps). Structural changes below do re-render.
   * ------------------------------------------------------------------ */
  sheetDoc.addEventListener("input", (e) => {
    const t = e.target;
    if (!t.classList.contains("sit-in")) return;
    const section = state.sections[+t.closest(".sit-section").dataset.si];
    if (!section) return;

    if (t.dataset.field) {                       // section header / fournisseur
      section[t.dataset.field] = t.value;
    } else if (t.dataset.shared) {               // shared block cell
      const bi = +t.closest("tbody").dataset.bi;
      section.blocks[bi][t.dataset.shared] = t.value;
    } else if (t.dataset.k) {                     // per-car cell
      const bi = +t.closest("tbody").dataset.bi;
      const ri = +t.closest("tr").dataset.ri;
      section.blocks[bi].rows[ri][t.dataset.k] = t.value;
    }
    save();
  });

  // Structural actions (add/remove) via one delegated click handler.
  sheetDoc.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const sectionEl = btn.closest(".sit-section");
    const si = +sectionEl.dataset.si;
    const act = btn.dataset.act;

    if (act === "add-block") {
      state.sections[si].blocks.push(newBlock());
    } else if (act === "del-section") {
      if (state.sections.length === 1) { flash("A sheet needs at least one section."); return; }
      state.sections.splice(si, 1);
    } else {
      // block-scoped actions
      const bi = +btn.closest("tbody").dataset.bi;
      const block = state.sections[si].blocks[bi];
      if (act === "add-row") {
        block.rows.push(newRow());
      } else if (act === "del-row") {
        if (block.rows.length === 1) { flash("A container needs at least one car."); return; }
        block.rows.pop();
      } else if (act === "del-block") {
        if (state.sections[si].blocks.length === 1) { flash("A section needs at least one container."); return; }
        state.sections[si].blocks.splice(bi, 1);
      }
    }
    render();
  });

  // Tiny inline note (reuses the app's toast if present, else alerts softly).
  function flash(msg) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show"); toast.hidden = false;
    setTimeout(() => { toast.classList.remove("show"); setTimeout(() => (toast.hidden = true), 300); }, 2200);
  }

  /* ------------------------------------------------------------------ *
   * Document-level controls
   * ------------------------------------------------------------------ */
  docTitleInput.addEventListener("input", () => {
    state.title = docTitleInput.value;
    const h = sheetDoc.querySelector(".sit-doc-title");
    if (h) h.textContent = state.title;
    else render();                 // title was empty before → need the heading
    save();
  });

  addSectionBtn.addEventListener("click", () => { state.sections.push(newSection()); render(); });

  clearSheetBtn.addEventListener("click", () => {
    if (!confirm("Clear the whole sheet and start fresh? This can't be undone.")) return;
    state = defaultState();
    render();
  });

  printSheetBtn.addEventListener("click", () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    window.print();
  });

  /* ------------------------------------------------------------------ *
   * View switcher (tabs in the header)
   * ------------------------------------------------------------------ */
  const tabs = Array.from(document.querySelectorAll(".view-tab"));
  const views = {
    extract: document.getElementById("view-extract"),
    sheet: document.getElementById("view-sheet"),
  };
  function showView(name) {
    if (!views[name]) name = "extract";
    Object.keys(views).forEach((k) => (views[k].hidden = k !== name));
    tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.view === name));
    try { localStorage.setItem("papercut-view", name); } catch (e) { /* ignore */ }
    window.scrollTo({ top: 0 });
  }
  tabs.forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

  /* ------------------------------------------------------------------ *
   * Init
   * ------------------------------------------------------------------ */
  render();
  let startView = "extract";
  try { startView = localStorage.getItem("papercut-view") || "extract"; } catch (e) { /* ignore */ }
  showView(startView);
})();
