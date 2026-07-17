/* ============================================================================
 * BKR Solution — PDF Page Extractor
 * script.js
 *
 * Everything runs in the browser. No servers, no uploads.
 *   - pdf-lib  → builds the new/extracted PDF (available as window.PDFLib)
 *   - pdf.js   → renders page thumbnails & the zoom preview (window.pdfjsLib)
 *   - JSZip    → bundles "separate files" downloads into one .zip (window.JSZip)
 *
 * The code is organised top-to-bottom as:
 *   1. Setup & references      2. App state       3. Small helpers
 *   4. File loading            5. Thumbnails      6. Selection & ranges
 *   7. Reordering (drag)       8. Delete / merge  9. Zoom preview
 *   10. Export (extract/zip)   11. Theme toggle   12. Wire up events
 * ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. SETUP & DOM REFERENCES
   * ------------------------------------------------------------------ */
  const { PDFDocument } = window.PDFLib;          // pdf-lib entry point
  const pdfjsLib = window.pdfjsLib;               // pdf.js entry point

  // pdf.js renders pages on a background "worker" thread. Point it at our
  // locally vendored worker file so nothing is fetched from the internet.
  pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

  const MAX_BYTES = 200 * 1024 * 1024;            // 200 MB upload guard
  const THUMB_WIDTH = 220;                        // thumbnail render width (px)

  // Grab elements once so we don't query the DOM repeatedly.
  const $ = (id) => document.getElementById(id);
  const els = {
    dropzone: $("dropzone"), fileInput: $("fileInput"), browseBtn: $("browseBtn"),
    uploadError: $("uploadError"), uploadSection: $("uploadSection"),
    workspace: $("workspace"),
    fileName: $("fileName"), fileSize: $("fileSize"),
    pageCount: $("pageCount"), selectedCount: $("selectedCount"),
    addPdfBtn: $("addPdfBtn"), mergeInput: $("mergeInput"), closeFileBtn: $("closeFileBtn"),
    selectAllBtn: $("selectAllBtn"), deselectAllBtn: $("deselectAllBtn"),
    deleteSelectedBtn: $("deleteSelectedBtn"),
    rangeInput: $("rangeInput"), applyRangeBtn: $("applyRangeBtn"), rangeError: $("rangeError"),
    pageGrid: $("pageGrid"),
    exportSummary: $("exportSummary"), extractBtn: $("extractBtn"), exportIndividualBtn: $("exportIndividualBtn"),
    // modal
    previewModal: $("previewModal"), previewLabel: $("previewLabel"),
    previewCanvasWrap: $("previewCanvasWrap"), prevPageBtn: $("prevPageBtn"), nextPageBtn: $("nextPageBtn"),
    // overlay + toast
    loadingOverlay: $("loadingOverlay"), loadingText: $("loadingText"), progressBar: $("progressBar"),
    toast: $("toast"),
    themeToggle: $("themeToggle"),
  };

  /* ------------------------------------------------------------------ *
   * 2. APP STATE
   *
   * We keep a "working document" (a pdf-lib PDFDocument) plus an ordered
   * list of page descriptors. Each page knows which source doc + index it
   * came from, so reordering/merging/deleting is just array manipulation;
   * the real PDF is only rebuilt at export time.
   * ------------------------------------------------------------------ */
  const state = {
    pages: [],          // [{ id, srcIndex, selected, rendered, canvas }]
    srcDoc: null,       // pdf-lib PDFDocument holding ALL source pages
    pdfjsDoc: null,     // pdf.js document used for rendering thumbnails
    fileName: "document.pdf",
    fileBytes: 0,       // original size, for display
    nextId: 1,
  };

  /* ------------------------------------------------------------------ *
   * 3. SMALL HELPERS
   * ------------------------------------------------------------------ */

  // Human-readable file size, e.g. 1536 → "1.5 KB".
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  // Filename without extension, e.g. "report.pdf" → "report".
  function stripExt(name) { return name.replace(/\.[^.]+$/, ""); }

  // Show a brief message at the bottom of the screen.
  let toastTimer;
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("toast-error", !!isError);
    els.toast.hidden = false;
    // Force reflow so the transition runs even on rapid repeat calls.
    void els.toast.offsetWidth;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("show");
      setTimeout(() => (els.toast.hidden = true), 300);
    }, 2600);
  }

  // Show / hide the full-screen loading overlay and update its progress bar.
  function showLoading(text) {
    els.loadingText.textContent = text || "Working…";
    els.progressBar.style.width = "0%";
    els.loadingOverlay.hidden = false;
  }
  function setProgress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    els.progressBar.style.width = pct + "%";
  }
  function hideLoading() { els.loadingOverlay.hidden = true; }

  // Read a File object into a Uint8Array (raw bytes) using a Promise.
  function readFileBytes(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.readAsArrayBuffer(file);
    });
  }

  // Trigger a browser download for some bytes.
  function downloadBytes(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime || "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a moment to start the download, then free memory.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Count of currently selected pages.
  function selectedCount() { return state.pages.filter((p) => p.selected).length; }

  /* ------------------------------------------------------------------ *
   * 4. FILE LOADING
   * ------------------------------------------------------------------ */

  // Validate + load a user-chosen PDF file as the new working document.
  async function loadPdf(file) {
    clearMessage(els.uploadError);

    // --- Validation: type & size -------------------------------------
    const looksPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!looksPdf) {
      showMessage(els.uploadError, "That doesn't look like a PDF. Please choose a .pdf file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      showMessage(els.uploadError, `That file is ${formatSize(file.size)}. The limit is 200 MB.`);
      return;
    }
    if (file.size === 0) {
      showMessage(els.uploadError, "That file is empty.");
      return;
    }

    showLoading("Reading your PDF…");
    try {
      const bytes = await readFileBytes(file);

      // Load with pdf-lib (for building output). ignoreEncryption lets us at
      // least open many password-light / permission-flagged PDFs.
      let srcDoc;
      try {
        srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      } catch (e) {
        throw new Error("This PDF looks corrupted or is password-protected, so it can't be opened.");
      }
      const pageCount = srcDoc.getPageCount();
      if (pageCount === 0) throw new Error("This PDF has no pages.");

      // Load with pdf.js (for rendering). It consumes the buffer, so pass a copy.
      const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

      // Commit to state.
      state.srcDoc = srcDoc;
      state.pdfjsDoc = pdfjsDoc;
      state.fileName = file.name;
      state.fileBytes = file.size;
      state.nextId = 1;
      state.pages = Array.from({ length: pageCount }, (_, i) => ({
        id: state.nextId++, srcIndex: i, selected: false, rendered: false, canvas: null,
      }));

      // Show the workspace and paint everything.
      els.uploadSection.hidden = true;
      els.workspace.hidden = false;
      updateFileInfo();
      renderGrid();
      toast(`Loaded ${pageCount} page${pageCount === 1 ? "" : "s"}.`);
    } catch (err) {
      showMessage(els.uploadError, err.message || "Something went wrong opening that PDF.");
    } finally {
      hideLoading();
    }
  }

  // Refresh the file-info card (name, size, counts).
  function updateFileInfo() {
    const n = state.pages.length;
    els.fileName.textContent = state.fileName;
    els.fileSize.textContent = formatSize(state.fileBytes);
    els.pageCount.textContent = `${n} page${n === 1 ? "" : "s"}`;
    els.selectedCount.textContent = `${selectedCount()} selected`;
    updateExportBar();
  }

  /* ------------------------------------------------------------------ *
   * 5. THUMBNAILS
   * ------------------------------------------------------------------ */

  // Build the whole grid from state.pages (order matters here).
  function renderGrid() {
    els.pageGrid.innerHTML = "";
    state.pages.forEach((page, position) => {
      els.pageGrid.appendChild(buildThumb(page, position));
    });
    // Render each page's image lazily so a big PDF doesn't freeze the UI.
    queueThumbRenders();
    updateFileInfo();
  }

  // Create a single thumbnail element (without its image yet).
  function buildThumb(page, position) {
    const cell = document.createElement("div");
    cell.className = "page-thumb" + (page.selected ? " is-selected" : "");
    cell.dataset.id = page.id;
    cell.draggable = true;               // enables drag-to-reorder (bonus)

    // page number badge (shows the CURRENT position, 1-based)
    const num = document.createElement("span");
    num.className = "page-num";
    num.textContent = position + 1;
    cell.appendChild(num);

    // selection checkmark
    const check = document.createElement("span");
    check.className = "page-check";
    check.textContent = "✓";
    cell.appendChild(check);

    // zoom button (opens the preview modal)
    const zoom = document.createElement("button");
    zoom.className = "page-zoom";
    zoom.type = "button";
    zoom.title = "Preview page";
    zoom.textContent = "🔍";
    zoom.addEventListener("click", (e) => { e.stopPropagation(); openPreview(page.id); });
    cell.appendChild(zoom);

    // If we already rendered this page's canvas before, reuse it.
    if (page.canvas) {
      cell.appendChild(page.canvas);
    } else {
      cell.classList.add("is-loading");
    }

    // Clicking the cell toggles selection.
    cell.addEventListener("click", () => toggleSelect(page.id));

    // Drag-to-reorder handlers.
    attachDragHandlers(cell, page.id);
    return cell;
  }

  // Render thumbnails one-by-one (non-blocking) for pages not yet drawn.
  let renderQueueRunning = false;
  async function queueThumbRenders() {
    if (renderQueueRunning) return;
    renderQueueRunning = true;
    for (const page of state.pages) {
      if (page.rendered) continue;
      try {
        const canvas = await renderPageCanvas(page.srcIndex, THUMB_WIDTH);
        page.canvas = canvas;
        page.rendered = true;
        // Insert the freshly rendered canvas into its cell (if still shown).
        const cell = els.pageGrid.querySelector(`.page-thumb[data-id="${page.id}"]`);
        if (cell) { cell.classList.remove("is-loading"); cell.appendChild(canvas); }
      } catch (e) {
        const cell = els.pageGrid.querySelector(`.page-thumb[data-id="${page.id}"]`);
        if (cell) { cell.classList.remove("is-loading"); cell.textContent = "⚠️"; }
      }
    }
    renderQueueRunning = false;
  }

  // Render a source page (0-based) to a canvas at a target pixel width.
  async function renderPageCanvas(srcIndex, targetWidth) {
    const pdfPage = await state.pdfjsDoc.getPage(srcIndex + 1); // pdf.js is 1-based
    const unscaled = pdfPage.getViewport({ scale: 1 });
    const scale = targetWidth / unscaled.width;
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas;
  }

  /* ------------------------------------------------------------------ *
   * 6. SELECTION & RANGE INPUT
   * ------------------------------------------------------------------ */

  function toggleSelect(id) {
    const page = state.pages.find((p) => p.id === id);
    if (!page) return;
    page.selected = !page.selected;
    const cell = els.pageGrid.querySelector(`.page-thumb[data-id="${id}"]`);
    if (cell) cell.classList.toggle("is-selected", page.selected);
    updateFileInfo();
  }

  function setAllSelected(value) {
    state.pages.forEach((p) => (p.selected = value));
    els.pageGrid.querySelectorAll(".page-thumb").forEach((c) => c.classList.toggle("is-selected", value));
    updateFileInfo();
  }

  /**
   * Parse a page-range string into a set of 1-based page numbers.
   * Accepts forms like: "1,3,5"  "1-10"  "1,3,5-10,15".
   * Throws an Error with a friendly message if anything is invalid.
   */
  function parseRange(text, maxPage) {
    const cleaned = text.trim();
    if (!cleaned) throw new Error("Type some page numbers first, e.g. 1, 3, 5-10.");

    const result = new Set();
    const parts = cleaned.split(",");

    for (let raw of parts) {
      const part = raw.trim();
      if (part === "") continue;

      if (part.includes("-")) {
        // a range like "5-10"
        const bits = part.split("-");
        if (bits.length !== 2) throw new Error(`"${part}" isn't a valid range.`);
        const a = Number(bits[0].trim());
        const b = Number(bits[1].trim());
        if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`"${part}" must use whole numbers.`);
        if (a < 1 || b < 1) throw new Error(`Page numbers start at 1 (got "${part}").`);
        if (a > maxPage || b > maxPage) throw new Error(`This document has ${maxPage} pages ("${part}" is out of range).`);
        const [lo, hi] = a <= b ? [a, b] : [b, a]; // tolerate "10-5"
        for (let n = lo; n <= hi; n++) result.add(n);
      } else {
        // a single page like "3"
        const n = Number(part);
        if (!Number.isInteger(n)) throw new Error(`"${part}" isn't a whole number.`);
        if (n < 1) throw new Error(`Page numbers start at 1 (got "${part}").`);
        if (n > maxPage) throw new Error(`This document has ${maxPage} pages ("${part}" is out of range).`);
        result.add(n);
      }
    }
    if (result.size === 0) throw new Error("No valid page numbers found.");
    return result;
  }

  function applyRange() {
    clearMessage(els.rangeError);
    try {
      // The range refers to CURRENT positions (what the user sees), 1-based.
      const wanted = parseRange(els.rangeInput.value, state.pages.length);
      state.pages.forEach((p, position) => (p.selected = wanted.has(position + 1)));
      renderGrid();
      toast(`Selected ${wanted.size} page${wanted.size === 1 ? "" : "s"}.`);
    } catch (err) {
      showMessage(els.rangeError, err.message);
    }
  }

  /* ------------------------------------------------------------------ *
   * 7. DRAG-TO-REORDER (bonus feature)
   * ------------------------------------------------------------------ */
  let dragId = null;

  function attachDragHandlers(cell, id) {
    cell.addEventListener("dragstart", (e) => {
      dragId = id;
      cell.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    cell.addEventListener("dragend", () => {
      dragId = null;
      cell.classList.remove("dragging");
      els.pageGrid.querySelectorAll(".drop-target").forEach((c) => c.classList.remove("drop-target"));
    });
    cell.addEventListener("dragover", (e) => { e.preventDefault(); cell.classList.add("drop-target"); });
    cell.addEventListener("dragleave", () => cell.classList.remove("drop-target"));
    cell.addEventListener("drop", (e) => {
      e.preventDefault();
      cell.classList.remove("drop-target");
      if (dragId == null || dragId === id) return;
      reorder(dragId, id);
    });
  }

  // Move the dragged page so it sits where the drop-target page is.
  function reorder(fromId, toId) {
    const from = state.pages.findIndex((p) => p.id === fromId);
    const to = state.pages.findIndex((p) => p.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = state.pages.splice(from, 1);
    state.pages.splice(to, 0, moved);
    renderGrid();
  }

  /* ------------------------------------------------------------------ *
   * 8. DELETE & MERGE
   * ------------------------------------------------------------------ */

  // Remove the selected pages from the working document (bonus feature).
  function deleteSelected() {
    const toDelete = selectedCount();
    if (toDelete === 0) { toast("No pages selected to delete.", true); return; }
    if (toDelete === state.pages.length) { toast("You can't delete every page.", true); return; }
    state.pages = state.pages.filter((p) => !p.selected);
    renderGrid();
    toast(`Deleted ${toDelete} page${toDelete === 1 ? "" : "s"}.`);
  }

  // Append the pages of ANOTHER pdf onto the current one (merge — bonus).
  async function mergePdf(file) {
    const looksPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!looksPdf) { toast("Please choose a PDF to merge.", true); return; }
    if (file.size > MAX_BYTES) { toast("That file is over the 200 MB limit.", true); return; }

    showLoading("Merging PDF…");
    try {
      const bytes = await readFileBytes(file);
      const incoming = await PDFDocument.load(bytes, { ignoreEncryption: true });

      // Copy incoming pages into our existing source document so every page
      // lives in one pdf-lib doc — that keeps export logic simple.
      const startIndex = state.srcDoc.getPageCount();
      const copied = await state.srcDoc.copyPages(incoming, incoming.getPageIndices());
      copied.forEach((pg) => state.srcDoc.addPage(pg));

      // Rebuild the pdf.js render doc from the merged bytes so new pages
      // can be previewed too.
      const mergedBytes = await state.srcDoc.save();
      state.pdfjsDoc = await pdfjsLib.getDocument({ data: mergedBytes.slice() }).promise;

      // Add descriptors for the newly appended pages.
      const added = incoming.getPageCount();
      for (let i = 0; i < added; i++) {
        state.pages.push({ id: state.nextId++, srcIndex: startIndex + i, selected: false, rendered: false, canvas: null });
      }
      // Existing thumbnails are still valid; only render the new ones.
      renderGrid();
      toast(`Merged ${added} page${added === 1 ? "" : "s"} from "${file.name}".`);
    } catch (err) {
      toast("Couldn't merge that PDF — it may be corrupted or protected.", true);
    } finally {
      hideLoading();
    }
  }

  /* ------------------------------------------------------------------ *
   * 9. ZOOM PREVIEW MODAL
   * ------------------------------------------------------------------ */
  let previewPos = 0; // current index within state.pages

  async function openPreview(id) {
    previewPos = state.pages.findIndex((p) => p.id === id);
    if (previewPos < 0) previewPos = 0;
    els.previewModal.hidden = false;
    await paintPreview();
  }
  function closePreview() { els.previewModal.hidden = true; els.previewCanvasWrap.innerHTML = ""; }

  async function paintPreview() {
    const page = state.pages[previewPos];
    if (!page) return;
    els.previewLabel.textContent = `Page ${previewPos + 1} of ${state.pages.length}`;
    els.previewCanvasWrap.innerHTML = "<div class='spinner-lg'></div>";
    try {
      // Render larger for a crisp zoomed preview.
      const canvas = await renderPageCanvas(page.srcIndex, 900);
      els.previewCanvasWrap.innerHTML = "";
      els.previewCanvasWrap.appendChild(canvas);
    } catch (e) {
      els.previewCanvasWrap.textContent = "⚠️ Could not render this page.";
    }
  }
  function previewStep(delta) {
    previewPos = (previewPos + delta + state.pages.length) % state.pages.length;
    paintPreview();
  }

  /* ------------------------------------------------------------------ *
   * 10. EXPORT — extract selected pages
   * ------------------------------------------------------------------ */

  // Keep the sticky export bar + delete button in sync with selection.
  function updateExportBar() {
    const n = selectedCount();
    els.exportSummary.textContent = `${n} page${n === 1 ? "" : "s"} selected`;
    els.extractBtn.disabled = n === 0;
    els.exportIndividualBtn.disabled = n === 0;
    els.deleteSelectedBtn.disabled = n === 0;
  }

  // Return the 0-based source indexes of selected pages, in display order.
  function selectedSrcIndexes() {
    return state.pages.filter((p) => p.selected).map((p) => p.srcIndex);
  }

  // Build ONE PDF containing all selected pages (in current order).
  async function extractToSinglePdf() {
    const indexes = selectedSrcIndexes();
    if (indexes.length === 0) { toast("Select at least one page.", true); return; }

    showLoading("Building your PDF…");
    try {
      const out = await PDFDocument.create();
      // copyPages preserves vectors, images, orientation & rotation → no quality loss.
      const copied = await out.copyPages(state.srcDoc, indexes);
      copied.forEach((pg, i) => { out.addPage(pg); setProgress(i + 1, indexes.length); });

      const bytes = await out.save();
      const name = `${stripExt(state.fileName)}_extracted.pdf`;
      downloadBytes(bytes, name);
      toast(`Downloaded ${indexes.length} page${indexes.length === 1 ? "" : "s"} · ${formatSize(bytes.byteLength)}`);
    } catch (err) {
      toast("Something went wrong building the PDF.", true);
    } finally {
      hideLoading();
    }
  }

  // Build one PDF PER selected page and download them together as a .zip.
  async function extractToSeparateFiles() {
    const pagesSel = state.pages.filter((p) => p.selected);
    if (pagesSel.length === 0) { toast("Select at least one page.", true); return; }

    showLoading("Creating separate files…");
    try {
      const zip = new JSZip();
      const stem = stripExt(state.fileName);
      for (let i = 0; i < pagesSel.length; i++) {
        const out = await PDFDocument.create();
        const [pg] = await out.copyPages(state.srcDoc, [pagesSel[i].srcIndex]);
        out.addPage(pg);
        const bytes = await out.save();
        // Name by the page's current display position for clarity.
        const position = state.pages.indexOf(pagesSel[i]) + 1;
        zip.file(`${stem}_page-${String(position).padStart(2, "0")}.pdf`, bytes);
        setProgress(i + 1, pagesSel.length);
      }
      const zipBytes = await zip.generateAsync({ type: "uint8array" });
      downloadBytes(zipBytes, `${stem}_pages.zip`, "application/zip");
      toast(`Downloaded ${pagesSel.length} files (zipped).`);
    } catch (err) {
      toast("Something went wrong creating the files.", true);
    } finally {
      hideLoading();
    }
  }

  /* ------------------------------------------------------------------ *
   * 11. THEME TOGGLE (dark mode — bonus)
   * ------------------------------------------------------------------ */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    els.themeToggle.querySelector(".theme-icon").textContent = theme === "dark" ? "☀️" : "🌙";
    try { localStorage.setItem("papercut-theme", theme); } catch (e) { /* storage may be blocked */ }
  }
  function initTheme() {
    let theme = "light";
    try { theme = localStorage.getItem("papercut-theme"); } catch (e) { /* ignore */ }
    if (!theme) {
      // Fall back to the operating-system preference on first visit.
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    applyTheme(theme);
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  }

  /* ------------------------------------------------------------------ *
   * Message helpers (inline error text)
   * ------------------------------------------------------------------ */
  function showMessage(el, text) { el.textContent = text; el.hidden = false; }
  function clearMessage(el) { el.textContent = ""; el.hidden = true; }

  // Reset everything back to the upload screen.
  function closeFile() {
    state.pages = [];
    state.srcDoc = null;
    state.pdfjsDoc = null;
    els.workspace.hidden = true;
    els.uploadSection.hidden = false;
    els.rangeInput.value = "";
    clearMessage(els.rangeError);
    clearMessage(els.uploadError);
  }

  /* ------------------------------------------------------------------ *
   * 12. WIRE UP EVENTS
   * ------------------------------------------------------------------ */

  // -- Upload: browse button + hidden input --------------------------
  els.browseBtn.addEventListener("click", (e) => { e.stopPropagation(); els.fileInput.click(); });
  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
  });
  els.fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) loadPdf(e.target.files[0]);
    e.target.value = ""; // allow re-selecting the same file later
  });

  // -- Upload: drag & drop -------------------------------------------
  ["dragenter", "dragover"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add("is-dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      // Only remove the highlight when actually leaving the dropzone.
      if (ev === "drop" || e.target === els.dropzone) els.dropzone.classList.remove("is-dragover");
    })
  );
  els.dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) loadPdf(e.dataTransfer.files[0]);
  });

  // -- Toolbar buttons -----------------------------------------------
  els.selectAllBtn.addEventListener("click", () => setAllSelected(true));
  els.deselectAllBtn.addEventListener("click", () => setAllSelected(false));
  els.deleteSelectedBtn.addEventListener("click", deleteSelected);
  els.applyRangeBtn.addEventListener("click", applyRange);
  els.rangeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyRange(); });

  // -- File card buttons ---------------------------------------------
  els.addPdfBtn.addEventListener("click", () => els.mergeInput.click());
  els.mergeInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) mergePdf(e.target.files[0]);
    e.target.value = "";
  });
  els.closeFileBtn.addEventListener("click", closeFile);

  // -- Export buttons ------------------------------------------------
  els.extractBtn.addEventListener("click", extractToSinglePdf);
  els.exportIndividualBtn.addEventListener("click", extractToSeparateFiles);

  // -- Preview modal -------------------------------------------------
  els.prevPageBtn.addEventListener("click", () => previewStep(-1));
  els.nextPageBtn.addEventListener("click", () => previewStep(1));
  els.previewModal.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closePreview));
  document.addEventListener("keydown", (e) => {
    if (els.previewModal.hidden) return;
    if (e.key === "Escape") closePreview();
    if (e.key === "ArrowLeft") previewStep(-1);
    if (e.key === "ArrowRight") previewStep(1);
  });

  // -- Theme ----------------------------------------------------------
  els.themeToggle.addEventListener("click", toggleTheme);
  initTheme();
})();
