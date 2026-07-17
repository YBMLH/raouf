# ✂️ BKR Solution — PDF & Situation Sheet Tools

A **professional, privacy-first PDF page extractor** that runs entirely in your
browser. Upload a PDF, pick the pages you want, and download a clean new file.
No backend, no database, no uploads — every file is processed locally on your
device.

Built to deploy for **$0/month on GitHub Pages**.

## ✨ Features

**Core**
- 📤 **Upload** — drag-and-drop *or* file picker, PDF-only, shows name, size & page count (handles files up to 200 MB)
- 🖼️ **Preview** — responsive thumbnail grid with clear page numbers and a 🔍 zoom preview modal
- ✅ **Selection** — click pages to select/deselect, with highlighted borders + checkmarks, plus **Select all** / **Deselect all**
- 🔢 **Range input** — type `1, 3, 5-10, 15` with full validation and friendly error messages
- 📄 **Generation** — builds a new PDF of only the selected pages, preserving original quality, orientation & formatting
- ⬇️ **Download** — one clean PDF, shows the resulting file size, and lets you keep extracting without refreshing

**Bonus**
- ↕️ **Drag-to-reorder** pages before exporting
- 🌙 **Dark mode** toggle (remembers your choice)
- ➕ **Merge** — append pages from another PDF
- 🗑️ **Delete** selected pages
- 📦 **Export as separate files** — one PDF per page, delivered as a `.zip`
- ⏳ **Loading indicators** with progress bars

## 🎨 Design

Elegant **black · white · beige · cream** palette with a warm espresso accent,
clean typography, smooth animations, and a responsive SaaS-style layout that
works on mobile, tablet and desktop — in both light and dark mode.

## 🔒 Privacy

Everything is client-side:

```
Open PDF → Browser renders it → You select pages → pdf-lib builds output → You download
```

Nothing leaves your computer. Refresh the page to clear everything.

## 📁 Project structure

```
index.html      # markup / UI structure
styles.css      # all styling + light/dark themes (CSS variables)
script.js       # all app logic (well commented for beginners)
lib/            # vendored libraries — no CDN, fully offline
  pdf-lib.min.js
  pdf.min.js
  pdf.worker.min.js
  jszip.min.js
```

Libraries used: [`pdf-lib`](https://pdf-lib.js.org/) (build PDFs),
[`pdf.js`](https://mozilla.github.io/pdf.js/) (render thumbnails/preview) and
[`JSZip`](https://stuk.github.io/jszip/) (zip the "separate files" download).
All are **vendored locally** in `lib/`, so there are no third-party requests.

## 🚀 Deploy on GitHub Pages

**Option A — GitHub Actions (recommended):** push to `main`, then set
**Settings → Pages → Source: GitHub Actions**. The included
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) publishes automatically.

**Option B — Branch source:** **Settings → Pages → Source: Deploy from a branch → `main` / root**.

The `.nojekyll` file makes GitHub serve the files as-is.

## 🖥️ Run locally

No build step. Serve the folder with any static server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(A local server is recommended over opening `index.html` via `file://` because
the pdf.js worker needs a normal `http(s)` origin.)

## 📄 License

Free to use and modify.
