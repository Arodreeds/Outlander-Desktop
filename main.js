const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Where the user's data actually lives. This is intentionally separate from
// Electron's own userData folder (~/Library/Application Support/...): that
// folder is meant for opaque app internals, not something a user should be
// expected to find, back up, or point at a synced Dropbox/iCloud folder.
//
// The *pointer* to the chosen save folder is the one thing that has to live
// in a fixed, Electron-managed spot (a tiny config.json in userData) — the
// save folder itself can move anywhere the user picks.
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_SAVE_FOLDER = path.join(app.getPath('documents'), 'Outlander Tour Companion');

function readConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}
function writeConfig(cfg) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) { /* non-fatal */ }
}

let saveFolder = readConfig().saveFolder || DEFAULT_SAVE_FOLDER;

function ensureFolders(folder) {
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(path.join(folder, 'photos'), { recursive: true });
}
ensureFolders(saveFolder);
if (!readConfig().saveFolder) writeConfig({ saveFolder });

// Maps the app's existing localStorage key names to files in the save folder,
// so the renderer's storage shim can stay a drop-in replacement for
// localStorage.getItem/setItem/removeItem with no per-key special-casing.
const KEY_TO_FILENAME = {
    outlanderTourState: 'save-data.json',
    outlanderGeocache: 'geocode-cache.json',
    outlanderAchievements: 'achievements.json',
    outlanderSeen: 'onboarding-seen.json'
};

function fileForKey(key) {
    const name = KEY_TO_FILENAME[key];
    if (!name) throw new Error('Unrecognized storage key: ' + key);
    return path.join(saveFolder, name);
}

// ---------------------------------------------------------------------------
// Synchronous storage IPC — deliberately blocking (ipcMain.on + event.returnValue)
// so the renderer's shim can preserve localStorage's synchronous contract and
// the app's existing call sites (saveState() returning true/false immediately,
// etc.) don't need to become async just to run inside Electron.
// ---------------------------------------------------------------------------
ipcMain.on('storage-get', (event, key) => {
    try {
        event.returnValue = fs.readFileSync(fileForKey(key), 'utf8');
    } catch (e) {
        event.returnValue = null; // matches localStorage.getItem's "not set" behavior
    }
});

ipcMain.on('storage-set', (event, key, value) => {
    try {
        fs.writeFileSync(fileForKey(key), value);
        event.returnValue = true;
    } catch (e) {
        event.returnValue = false;
    }
});

ipcMain.on('storage-remove', (event, key) => {
    try {
        fs.unlinkSync(fileForKey(key));
    } catch (e) { /* already gone is fine */ }
    event.returnValue = true;
});

// ---------------------------------------------------------------------------
// Photo storage — real image files in <saveFolder>/photos/, so they're visible
// and browsable in Finder rather than opaque IndexedDB blobs. The renderer
// still deals exclusively in data URIs (matching the existing PhotoStore
// contract), so no caller code beyond PhotoStore itself needs to change.
// ---------------------------------------------------------------------------
function extForMime(mime) {
    if (mime === 'image/png') return 'png';
    if (mime === 'image/webp') return 'webp';
    return 'jpg'; // the app's own upload flow always re-encodes to image/jpeg
}
function mimeForExt(ext) {
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    return 'image/jpeg';
}
function dataUriToBuffer(dataUri) {
    const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUri);
    if (!match) throw new Error('Not a base64 data URI');
    return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}
function photosDir() { return path.join(saveFolder, 'photos'); }
function findPhotoFile(id) {
    const dir = photosDir();
    const hit = fs.readdirSync(dir).find(f => path.parse(f).name === id);
    return hit ? path.join(dir, hit) : null;
}

ipcMain.handle('photo-set', async (event, id, dataUri) => {
    const { mime, buffer } = dataUriToBuffer(dataUri);
    // Remove any existing file for this id first (in case the extension/mime changed).
    const existing = findPhotoFile(id);
    if (existing) fs.unlinkSync(existing);
    fs.writeFileSync(path.join(photosDir(), `${id}.${extForMime(mime)}`), buffer);
    return true;
});

ipcMain.handle('photo-get', async (event, id) => {
    const file = findPhotoFile(id);
    if (!file) return null;
    const buffer = fs.readFileSync(file);
    return `data:${mimeForExt(path.extname(file))};base64,${buffer.toString('base64')}`;
});

ipcMain.handle('photo-del', async (event, id) => {
    const file = findPhotoFile(id);
    if (file) fs.unlinkSync(file);
    return true;
});

ipcMain.handle('photo-all', async () => {
    const dir = photosDir();
    const out = {};
    for (const filename of fs.readdirSync(dir)) {
        const full = path.join(dir, filename);
        if (!fs.statSync(full).isFile()) continue;
        const id = path.parse(filename).name;
        const buffer = fs.readFileSync(full);
        out[id] = `data:${mimeForExt(path.extname(filename))};base64,${buffer.toString('base64')}`;
    }
    return out;
});

// ---------------------------------------------------------------------------
// Save-folder management — one shared implementation used by both the
// renderer's Settings button (via IPC) and the native "Change Save Folder…"
// menu item, so there's exactly one place that knows how to migrate data.
// ---------------------------------------------------------------------------
async function promptAndChangeSaveFolder(win) {
    const result = await dialog.showOpenDialog(win, {
        title: 'Choose a folder to store your tour data',
        defaultPath: saveFolder,
        properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return { changed: false, saveFolder };

    const newFolder = result.filePaths[0];
    if (path.resolve(newFolder) === path.resolve(saveFolder)) return { changed: false, saveFolder };

    // Bring the existing save files and photos along, so switching folders
    // (e.g. into a Dropbox/iCloud Drive folder) doesn't look like data loss.
    ensureFolders(newFolder);
    for (const filename of Object.values(KEY_TO_FILENAME)) {
        const src = path.join(saveFolder, filename);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(newFolder, filename));
    }
    const oldPhotos = photosDir();
    if (fs.existsSync(oldPhotos)) {
        for (const filename of fs.readdirSync(oldPhotos)) {
            fs.copyFileSync(path.join(oldPhotos, filename), path.join(newFolder, 'photos', filename));
        }
    }

    saveFolder = newFolder;
    writeConfig({ saveFolder });
    return { changed: true, saveFolder };
}

ipcMain.handle('get-save-folder', async () => saveFolder);
ipcMain.handle('reveal-save-folder', async () => { shell.openPath(saveFolder); });
ipcMain.handle('choose-save-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return promptAndChangeSaveFolder(win);
});

// ---------------------------------------------------------------------------
// Window + menu
// ---------------------------------------------------------------------------
function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#12161a',
        title: 'Outlander in Concert — Tour Companion',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    win.loadFile('index.html');
    return win;
}

function buildMenu(win) {
    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' }, { type: 'separator' },
                { role: 'services' }, { type: 'separator' },
                { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
                { role: 'quit' }
            ]
        }] : []),
        {
            label: 'Data',
            submenu: [
                { label: 'Reveal Save Folder', click: () => shell.openPath(saveFolder) },
                {
                    label: 'Change Save Folder…',
                    click: async () => {
                        const result = await promptAndChangeSaveFolder(win);
                        if (result.changed) win.webContents.reload();
                    }
                }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
                { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
                { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Window',
            submenu: [{ role: 'minimize' }, { role: 'close' }]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
    const win = createWindow();
    buildMenu(win);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            const w = createWindow();
            buildMenu(w);
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
