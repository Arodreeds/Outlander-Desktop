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
- `build/icon.icns` — the app icon (built from the same pixel-art "Lag" sprite
  used as the map's city markers and the page's own favicon).

## Where user data actually lives

By default: **`~/Documents/Outlander Tour Companion/`**

```
save-data.json          — main app state (was localStorage["outlanderTourState"])
geocode-cache.json      — cached venue coordinates
achievements.json       — earned achievements
onboarding-seen.json    — whether the welcome screen has been dismissed
photos/<cityId>.jpg     — real, double-clickable photo files (was IndexedDB)
```

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

## Test scripts (optional, not part of the shipped app)

`e2e_test.js` and `e2e_packaged_test.js` drive the app end-to-end with
Playwright's Electron support (storage round-trips, photo files, the Save
Location UI, launching the actual packaged `.app`). They're not needed to
build or run the app — only if you want to re-verify things after making
changes. To use them:

```bash
npm install --no-save playwright   # temporary — not a real dependency of the app
node e2e_test.js                   # exercises dev mode (npm start equivalent)
node e2e_packaged_test.js          # launches the actual built dist/mac/*.app
npm uninstall playwright           # remove it again afterward
```

Note: by default `npm install playwright` also downloads ~500MB of browser
binaries (Chromium/Firefox/WebKit) it doesn't actually need for this — only
the Electron driver is used. Clean that up afterward too if disk space
matters: `rm -rf ~/Library/Caches/ms-playwright`.
