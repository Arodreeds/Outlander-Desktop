const { contextBridge, ipcRenderer } = require('electron');

// Synchronous, matching localStorage's own contract — see main.js for why.
contextBridge.exposeInMainWorld('electronStorage', {
    getItem: (key) => ipcRenderer.sendSync('storage-get', key),
    setItem: (key, value) => ipcRenderer.sendSync('storage-set', key, value),
    removeItem: (key) => ipcRenderer.sendSync('storage-remove', key)
});

// Async, matching PhotoStore's existing IndexedDB-based contract.
contextBridge.exposeInMainWorld('electronPhotos', {
    set: (id, dataUri) => ipcRenderer.invoke('photo-set', id, dataUri),
    get: (id) => ipcRenderer.invoke('photo-get', id),
    del: (id) => ipcRenderer.invoke('photo-del', id),
    all: () => ipcRenderer.invoke('photo-all')
});

contextBridge.exposeInMainWorld('electronSaveFolder', {
    get: () => ipcRenderer.invoke('get-save-folder'),
    choose: () => ipcRenderer.invoke('choose-save-folder'),
    reveal: () => ipcRenderer.invoke('reveal-save-folder')
});

contextBridge.exposeInMainWorld('isElectron', true);
