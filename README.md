# 📄 PDF Toolkit

A **free, privacy-first PDF toolkit** that runs entirely in your browser. No
uploads, no backend, no database, no sign-up. Every file you open is processed
locally on your device — nothing is ever sent to a server.

Built to be deployed for **$0/month on GitHub Pages**.

## ✨ Tools

| Tool | What it does |
| --- | --- |
| 🔗 **Merge** | Combine several PDFs into one (drag to reorder). |
| ✂️ **Split** | Break a PDF into single pages, every N pages, or custom ranges → `.zip`. |
| 📑 **Extract** | Pick pages from thumbnails and save them as a new PDF. |
| 🗑️ **Delete** | Remove selected pages, keep the rest. |
| 🔄 **Rotate** | Turn selected pages (or all) 90° at a time. |
| 🗜️ **Compress** | Shrink file size by rasterizing pages (great for scanned PDFs). |
| 🖼️ **PDF → Images** | Render each page to PNG/JPEG, downloaded as a `.zip`. |
| 📸 **Images → PDF** | Turn JPG/PNG images into a single PDF (drag to reorder). |

## 🔒 Privacy

All work happens client-side:

```
User adds file → Browser reads it → You edit/select → pdf-lib builds output → You download
```

Nothing leaves your computer. Refresh the page to clear everything.

## 🧩 How it works

- [`pdf-lib`](https://pdf-lib.js.org/) — creating and manipulating PDFs
- [`pdf.js`](https://mozilla.github.io/pdf.js/) — rendering page thumbnails & rasterizing
- [`JSZip`](https://stuk.github.io/jszip/) — bundling multi-file downloads into a `.zip`

All libraries are **vendored locally** in [`js/vendor/`](js/vendor) — no CDN, no
third-party requests, works fully offline. Just static files: `index.html`,
`css/`, and `js/`.

## 🚀 Deploy on GitHub Pages

**Option A — GitHub Actions (recommended):**
1. Push to `main`.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. The included [`deploy.yml`](.github/workflows/deploy.yml) workflow publishes automatically.

**Option B — Branch source:**
1. Repo **Settings → Pages → Source: Deploy from a branch → `main` / root**.

The `.nojekyll` file ensures GitHub serves the files as-is.

## 🖥️ Run locally

No build step. Serve the folder with any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` directly via `file://` mostly works, but a local server
avoids browser restrictions on the pdf.js web worker.)

## 📄 License

Free to use and modify.
