# Region Image Grabber

Chrome extension (Manifest V3): drag a rectangle on any web page, preview every image inside it, and download the ones you pick, either one at a time or as a `.zip`. Before downloading, each image can be resized, converted to PNG / JPG / WebP, sharpened ("HD"), or AI-upscaled to 4K.

Built with [WXT](https://wxt.dev), TypeScript, Preact (rendered in a closed Shadow DOM), [fflate](https://github.com/101arrowz/fflate) and [ONNX Runtime Web](https://onnxruntime.ai/) running the [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) model.

## Build

Requires Node 20+.

```bash
npm install        # also runs `wxt prepare` (generates .wxt/ types)
npm run build      # → dist/chrome-mv3/
npm test           # unit tests (Vitest)
npm run compile    # type-check
```

Other scripts:

| Script          | What it does                                                    |
| --------------- | --------------------------------------------------------------- |
| `npm run dev`   | Dev build with hot reload; opens a fresh Chrome with the extension loaded |
| `npm run zip`   | Production build zipped for the Chrome Web Store                |

## Load unpacked

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `dist/chrome-mv3` folder.
5. Optional: pin the extension from the puzzle-piece menu.

After rebuilding, click the reload ↻ icon on the extension card, then refresh any tab you want to use it in.

The unpacked extension is about 31 MB. Most of that is the AI runtime (25.5 MB of WebAssembly) and the model (4.9 MB).

## Usage

Start a selection with any of these:

- the toolbar icon
- **Alt+Shift+S** (on macOS, Option+Shift+S; change it at `chrome://extensions/shortcuts`)
- right-click → **Select region to grab images**

Then:

1. Drag a rectangle. **Esc** cancels.
2. The images found in the rectangle are outlined on the page, and a panel opens on the right.
3. In the panel you can tick or untick images, change the **Min size** filter (default 50 px), or use **Select all / none**. Hovering a thumbnail highlights its image on the page.
4. **Download selected** saves a single image directly. When more than one is selected, it builds a zip. **Download all (.zip)** always builds a zip of every image that passes the filter.
5. To change an image's output, hover its card and click **✎**. See [Editing an image](#editing-an-image).
6. **Reselect** draws a new region. **×** or **Esc** closes the panel. Closing removes the overlay, the outlines, the panel and every listener.

Files are named `{hostname}_{index}.{ext}`, and zips are named `{hostname}_{YYYYMMDD-HHmm}.zip`. The extension is taken from the `Content-Type` header. If that is missing or generic, it is detected from the file's magic bytes, and failing that, from the URL.

### Editing an image

The editor replaces the grid inside the panel. **Done**, **← All images** or **Esc** returns to the grid. Settings are applied when you download. Cards with changed settings show the result, for example `→ 3840×2560 PNG · AI`.

| Setting | Options |
| ------- | ------- |
| **Crop** | Click **Crop** to show a crop box on the preview. Drag the 8 handles to resize it, drag inside it to move it, or drag on the darkened area to draw a new box. Aspect presets: Free, Original, 1:1, 4:3, 3:4, 16:9, 9:16. With a fixed ratio, only the corner handles are shown. The crop is stored as fractions of the image and applied to the full-resolution file **before** resize, HD/AI and format conversion, so *Size* and *4K AI* work on the cropped area. SVGs are rendered at output resolution before cutting, so they stay sharp. Rows show a thumbnail of the cropped area. **Reset crop** goes back to the whole image. |
| **File name** | A custom name for the saved file. Leave it empty for the automatic `{hostname}_{index}` name. The extension is added for you and follows the output format, so typing `wallet.jpg` while exporting WebP saves `wallet.webp`. Characters that aren't allowed in file names (`/ \ : * ? " < > \|`) become `_`. Leading and trailing dots and spaces are removed, and Windows device names such as `CON` are prefixed. Names with accents and other non-ASCII characters (for example Vietnamese) are kept, and stored as UTF-8 inside zips. When two images share a name, the zip gets `name (2).ext`, and the editor warns you beforehand. |
| **Enhance** | **None**. **HD**: high-quality resampling plus an unsharp-mask filter with a *Sharpness* slider. Turning it on sets the size to 200%. It is instant. **4K AI**: Real-ESRGAN super-resolution to 3840 px on the long side. |
| **Size** | Width × height with an aspect-ratio lock, or the presets 50% / 100% / 200% / 400%. Disabled for 4K AI, which sets the size itself. |
| **Format** | **Original** keeps PNG, JPG and WebP files as they are. GIF, SVG, AVIF and other formats become PNG once they need re-encoding, because Chrome can only encode PNG, JPG and WebP. JPG and WebP have a *Quality* slider (50–100). JPG output is flattened onto white. |

**Apply to selected** copies the current size, format and enhance settings to every other selected image. It doesn't copy the file name or the crop, because those depend on the individual picture. An exact pixel size is converted into a percentage, so every image keeps its own aspect ratio. **Reset** returns the image to "original file".

An image with no changes is saved byte-for-byte, so animated GIFs and the original metadata are kept.

#### 4K AI

- **Cost:** free. The model runs entirely on your computer. There's no API, no account, no per-image charge, and no image ever leaves the machine.
- **Speed:** on an Apple M1 Pro with WebGPU, a 900×600 image takes about 6 s to reach 3840×2560, and a 128 px icon takes about 3 s. Without WebGPU it falls back to the CPU, which is much slower.
- **How it works:** the model upscales ×4 in 192 px tiles. Overlapping borders are thrown away so no seams show. Inputs are first reduced to 960 px on the long side, because a larger input would only be shrunk again after the ×4 step. Images smaller than 480 px get a second ×4 pass. The result is then resized to exactly 3840 px.
- **Transparency:** for images with transparency, the alpha mask is upscaled by the AI as well, so edges stay sharp. Edge colours are spread into transparent pixels first to avoid dark fringes. This doubles the processing time for those images.
- **SVG:** SVGs skip the AI and are rendered directly at 4K, since they're vector graphics.
- **Cancel:** you can stop processing with the **Cancel** link in the footer.

### Duplicates

When the panel opens, every image is fetched and fingerprinted in the background. This takes well under a second for a typical selection. Look-alike images are grouped together, even when they come in different sizes, formats or compression levels, or as `<img>` vs. CSS background.

Two images count as duplicates only when all of these agree:

- **Aspect ratio** and **mean colour**.
- A 64-bit perceptual **dHash**. This is only a quick pre-filter.
- A **16×16 colour thumbnail, compared cell by cell.** Every cell must be close, and the largest channel difference in any cell has to stay small. Shop pages often put every product in the same template (logo, corner banner, promo box), which makes whole-image hashes look alike. Comparing cell by cell catches the region where the products differ, even a brown and a black version of the same wallet.

Grouping isn't transitive. Each image is compared directly with the best (largest) copy of a group, so "A looks a bit like B, B looks a bit like C" never pulls A and C together.

Images that can't be fetched fall back to comparing normalised URLs. That comparison ignores CDN size and format parameters (`?w=`, `fm=`, `-300x200`, `@2x`, Cloudinary `w_400,…`, Google `=s400`, …).

- Each group is listed together. The largest copy is labelled **Best of N** and stays ticked, and the others are labelled **Duplicate** and are unticked automatically. You can tick them again at any time, or use **Deselect duplicates** to untick them again.
- Hovering a row outlines its look-alikes on the page.
- Fetching the images also reveals their real pixel size and file format. This matters for CSS backgrounds and for URLs without an extension, which used to show `?`. The fetched bytes are cached (up to 200 MB), so downloading afterwards doesn't fetch them again.
- The **Duplicates** switch turns the feature off. Turning it off re-ticks the images it had unticked, and the choice is remembered (`chrome.storage.local`).

### Images from other domains

Initially the extension can only fetch from the site you're on (`activeTab`). Many sites host their images on a CDN that doesn't send CORS headers, so those images fail with *"Blocked (cross-origin)"*. In that case the panel shows a **Grant access to all sites** link. It opens a page that requests the optional `<all_urls>` host permission. Grant it, go back to the page and download again. A single image is still saved even without the permission, because the extension falls back to `chrome.downloads` by URL.

## How detection works

The logic is in `lib/detectImages.ts` (`detectImages(rect)`). It merges two sources of candidates:

1. **DOM scan.** It checks `<img>` (including `<picture><source>` srcsets), inline `<svg>`, `<canvas>`, `<video poster>`, SVG `<image>`, and any element whose computed `background-image` (or `::before` / `::after` `background-image` / `content`) contains a `url(...)`.
2. **Grid sampling.** It calls `document.elementsFromPoint()` about every 20 px across the visible part of the rectangle. This returns every layer at each point, so it finds images hidden under transparent overlay divs (as on Instagram and Pinterest). It also looks inside open shadow roots, which the DOM scan can't see.

For each candidate, it applies these rules:

- The candidate is kept when at least 30% of its area falls inside the rectangle (configurable with `minOverlap`).
- It is skipped if it is `display: none`, `visibility: hidden`, or has an ancestor with `opacity: 0`. Elements smaller than 8 px are also skipped. The panel then applies its own, adjustable minimum size.
- The URL is chosen in this order: the largest `srcset` candidate, then `currentSrc`, then `src`, then `data-src` / `data-original` / `data-lazy-src` / `data-srcset`. Tiny `data:` placeholders used by lazy loaders are ignored.
- Inline SVGs are serialized to a `blob:` URL, with sprite `<use>` references inlined. Canvases are exported with `toDataURL()`. A tainted canvas is skipped.
- Results are deduplicated by final URL and sorted in reading order.

The selection rectangle is stored in document coordinates, so it stays attached to the page if you scroll during a drag. When you release, it is converted back to viewport coordinates for detection. The outlines are recalculated from live `getBoundingClientRect()` values on every scroll and resize.

## Architecture

```
content script ──ensure-offscreen──▶ service worker ──creates──▶ offscreen document
      │                                   ▲                            │
      └────────── runtime.Port: items + per-image settings ───────────▶│ fetch → resize / convert /
                  ◀── progress, per-item results, done ─────────────────│ HD / AI (WebGPU) → zip
                                          │◀── save(blob: URL, name) ──┘
                                          └─ chrome.downloads
```


```
entrypoints/
  background.ts      service worker: action/command/context menu → inject content script;
                     creates/closes the offscreen document; chrome.downloads
  offscreen/         hidden extension page that does the heavy work
    main.ts          download + duplicate-scan jobs; hands blob: URLs to the worker
    fetcher.ts       fetch with a 200 MB byte cache shared by both jobs
    fingerprint.ts   decode → 64×64 → dHash (9×8), 16×16 RGB thumbnail, aspect, mean colour
    process.ts       decode → crop → resize / HD sharpen / AI passes → encode (OffscreenCanvas)
    upscaler.ts      ONNX Runtime session (WebGPU, falls back to WASM) and tiled ×4 inference
  content.ts         mounts a closed Shadow DOM host; tears down on close or re-injection
  grant/             page that requests the optional <all_urls> permission (needs a user gesture)
components/
  App.tsx            session state machine: selecting → results
  SelectionOverlay.tsx
  Highlights.tsx     outlines over detected images
  Panel.tsx          preview UI
  Editor.tsx         per-image crop / name / enhance / size / format editor
  CropEditor.tsx     draggable crop box + cropped row thumbnails
  styles.css         injected into the shadow root (?inline)
lib/
  detectImages.ts    detection (DOM scan + elementsFromPoint sampling)
  resolveUrl.ts      srcset / CSS url() / image-set() / lazy-attribute parsing
  fileNames.ts       extension inference, file and zip names
  base64.ts          base64 and data: URL helpers
  output.ts          output settings, crop + target-size math, AI pass planning
  dupes.ts           dHash, cell-by-cell thumbnail distance, URL normalisation, grouping (pure)
  offscreenClient.ts / downloadClient.ts / hashClient.ts   content-script side of the ports
  imageOps.ts        unsharp mask, tiling, tensor packing, transparency helpers (pure)
  messages.ts        message types
public/models/       realesr-general-x4v3.onnx + its BSD-3 license
scripts/
  convert-model.py   rebuilds the ONNX model from the official Real-ESRGAN weights
tests/               Vitest unit tests
```

- The content script is only injected on demand (`registration: 'runtime'` plus `chrome.scripting.executeScript`), so the extension doesn't run on pages until you use it. Injecting again into the same tab replaces the previous session.
- The heavy work runs in an [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen). It has what an MV3 service worker lacks: WebGPU-friendly canvas, `<img>` decoding for SVG, and `URL.createObjectURL`. It is created when a download starts and closed after 60 s idle, which frees the model's GPU memory.
- Downloads go through a long-lived `runtime.Port`, which streams progress and a result for each image back to the panel. When an image fails, the error is shown on its card and the rest keep going. Closing the panel or pressing **Cancel** disconnects the port, which aborts the job between AI tiles.
- `blob:` and `data:` URLs only exist in the page, so the content script reads them and sends them as base64. Everything else is fetched by the extension, which isn't limited by the page's CORS rules.
- The extension makes no network requests of its own apart from fetching the images you choose. The model and the ONNX Runtime files are part of the package. The extension's CSP adds `'wasm-unsafe-eval'`, which ONNX Runtime needs to compile its WebAssembly.

### Rebuilding the AI model

`public/models/realesr-general-x4v3.onnx` is already in the repo. To regenerate it, follow the instructions at the top of `scripts/convert-model.py` (Python, PyTorch, the official weights). The script checks that the ONNX output matches PyTorch's. It rewrites PReLU and PixelShuffle using basic ops, so every layer runs on the WebGPU execution provider.

## Permissions

| Permission                         | Why                                                             |
| ---------------------------------- | --------------------------------------------------------------- |
| `activeTab`                        | Temporary access to the current tab when you start a selection  |
| `scripting`                        | Inject the selection UI on demand                               |
| `downloads`                        | Save images and zips                                            |
| `contextMenus`                     | Right-click entry                                               |
| `offscreen`                        | Hidden page that resizes, converts, AI-upscales and zips images |
| `storage`                          | Remember whether duplicate detection is on                      |
| `<all_urls>` (optional host)       | Only if you grant it: fetch images from CDNs without CORS headers |

## Known limitations (MVP)

These are not implemented yet: iframes, auto-scrolling while selecting, per-site "original resolution" rules, screenshot cropping of the page itself, AVIF output, rotate/flip, and a before/after preview of HD/AI results.

Other current limitations:

- Images inside closed shadow roots can't be detected.
- Images protected by a hotlink `Referer` check can fail to download, because requests from the extension carry no page referrer.
- Zips are built in memory. This works for hundreds of typical images, or dozens of 4K ones, but isn't suited to gigabytes.
- 4K AI is tuned for photos and general images. Very small or heavily compressed images can come out looking "painted". Compare with **HD** when that happens.
