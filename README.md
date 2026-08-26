# Outlander Tour Companion — Desktop

Electron wrapper around the single-file Outlander Tour Companion web app, packaged
as a real downloadable macOS app — no developer account, no App Store.

## Layout

- `index.html` — **the canonical source going forward.** This is a copy of the
  original standalone HTML file, with three additions: a storage shim that
  writes to real files instead of localStorage/IndexedDB when running inside
  Electron, and a "Save Location" section in Settings. If you're the one
  making feature changes to the app itself (new cities, UI tweaks, etc.), make
  them here — not in the old Downloads copy, which this project no longer uses.
- `main.js` — Electron's main process: creates the window, the native menu,
  and all the file-system IPC handlers (save data, photos, save-folder
  management).
- `preload.js` — securely exposes `window.electronStorage` / `electronPhotos` /
  `electronSaveFolder` to the page, via `contextBridge` (no Node access is
  given directly to the page itself — standard Electron security practice).
- `build/icon.icns` / `build/icon.png` — the app icon (built from the same
  pixel-art "Lag" sprite used as the map's city markers and the page's own
  favicon), rendered as a transparent PNG and packed into an .icns.
- `fonts/` — Cinzel and EB Garamond, decoded out of `index.html`'s old inline
  base64 `@font-face` rules into real `.woff2`/`.woff` files (English-only
  subset; the redundant broad-Unicode variants Google Fonts also ships were
  dropped). Referenced from `index.html` via plain relative `url(...)`.
- `vendor/leaflet.{css,js}` — the Leaflet map library, likewise pulled out of
  the inline `<head>` block. It's now injected on demand (a `<link>`/`<script>`
  added at runtime) the first time a city panel actually opens its live venue
  map, instead of being parsed on every launch.

## Where user data actually lives

By default: **`~/Documents/Outlander Tour Companion/`**

```
save-data.json          — main app state (was localStorage["outlanderTourState"])
geocode-cache.json      — cached venue coordinates
achievements.json       — earned achievements
onboarding-seen.json    — whether the welcome screen has been dismissed
photos/<cityId>.jpg     — real, double-clickable photo files (was IndexedDB)
backups/<timestamp>/    — automatic snapshots of the four files above + photos
```

Backups are taken automatically — after every show you mark complete, and
once per launch if the last snapshot is more than a day old — and pruned to
the most recent 20. They live inside the save folder itself rather than
Electron's own app-data folder, so pointing Save Location at a synced
Dropbox/iCloud folder carries backup history along too. They're also left
alone by "Reset Entire Tour Data," so a mistaken reset without exporting
first is still recoverable from here.

Users can change this folder from Settings → Save Location → "Change Folder…"
(or the app's "Data" menu) — pointing it at a Dropbox/iCloud Drive/OneDrive
folder gives free cross-device sync. Existing data is copied to the new
location automatically when they do.

Electron's own `~/Library/Application Support/Outlander Tour Companion/`
folder holds exactly one tiny file (`config.json`) — just a pointer to
whichever folder above is currently active. It's not meant to be user-facing.

## Running it

```bash
npm install       # first time only
npm start          # launch in dev mode
npm run dist       # build the distributable .dmg + .zip into dist/
```

`npm run dist` builds for macOS x64 only (Intel). To also build a build that
runs natively on Apple Silicon, use `npm run dist:universal` instead — this
was not verified in this environment (only Intel hardware was available to
test on), so treat it as unverified until you've actually launched the result
on an Apple Silicon Mac.

`npm run dist:win` (NSIS installer + portable .exe) and `npm run dist:linux`
(AppImage) exist for local testing, but electron-builder can't reliably
cross-compile these from macOS (the NSIS installer needs Wine; Linux
packaging is happiest built on Linux). The real release path is the
`.github/workflows/release.yml` GitHub Actions workflow: push a `v*` tag (or
run it manually via "Run workflow" in the Actions tab) and it builds all
three platforms natively on their own runners, then attaches every artifact
to the GitHub Release for that tag — the same release the app's own
"Check for Updates" points at.

## The security prompt your users will see (this is normal)

This app is **not code-signed** — that requires a paid Apple Developer Program
membership ($99/year), which was the whole point of avoiding this route. On
first launch, after downloading it from wherever you host it, macOS Gatekeeper
will say it can't verify the developer. This is expected and not a sign
anything is broken. Tell people to either:

- **Right-click (or Control-click) the app → Open** → a dialog appears with
  an "Open" button, or
- If that doesn't show an Open button on their macOS version: **System
  Settings → Privacy & Security** → scroll down → **"Open Anyway"** (only
  appears after the first blocked attempt).

This is a one-time step per install. If this friction becomes a real problem
later, the fix is Apple notarization ($99/year Developer Program + running
the build through `xcrun notarytool` before distributing) — genuinely
optional, not required to ship.

The Windows and Linux builds are unsigned for the same reason (no paid
certificate):

- **Windows**: first launch shows a blue "Windows protected your PC"
  SmartScreen screen. Tell people to click **"More info"** → **"Run anyway"**.
  One-time per install, same idea as the mac Gatekeeper prompt above.
- **Linux (AppImage)**: after downloading, it needs the executable bit set
  before it will run: `chmod +x "Outlander Tour Companion-*.AppImage"`, then
  double-click or run it directly. This is standard for any unsigned
  AppImage, not specific to this app.

## Test scripts (optional, not part of the shipped app)

`e2e_test.js`, `e2e_packaged_test.js`, `e2e_update_test.js`, and friends drive
the app end-to-end with Playwright's Electron support (storage round-trips,
photo files, the Save Location UI, launching the actual packaged `.app`, the
Settings "Check for Updates" flow). `e2e_feature_smoke_test.js` is the odd one
out — instead of storage plumbing, it drives the actual app-level features a
user touches: search, timeline filters, the city panel (notes/photo/receipts/
expenses/social/instrument checklist, saved and reopened), marking a show
complete end-to-end (achievements, dashboard, the Saxbyte walk), favorites,
gallery, recap, every export format, and an import round trip through a real
`location.reload()`. None of these are needed to build or run the app — only
if you want to re-verify things after making changes. `playwright` is a real
devDependency (kept installed since these run often — `npm install` pulls it
in), so just run:

```bash
node e2e_test.js                   # exercises dev mode (npm start equivalent)
node e2e_packaged_test.js          # launches the actual built dist/mac/*.app
node e2e_update_test.js            # exercises the update-checker (hits the real GitHub API)
node e2e_feature_smoke_test.js     # full feature pass: city panel, exports, achievements, etc.
```

Note: `npm install` for `playwright` also downloads ~500MB of browser
binaries (Chromium/Firefox/WebKit) it doesn't actually need — only the
Electron driver is used. Safe to clean up if disk space matters:
`rm -rf ~/Library/Caches/ms-playwright` (re-downloaded automatically if a
`playwright`-dependent script runs again and it's missing).
