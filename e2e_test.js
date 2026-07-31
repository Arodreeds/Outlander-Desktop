const path = require('path');
const fs = require('fs');
const { launch, cleanupTestRoot, Suite } = require('./e2e_helpers');

(async () => {
    const t = new Suite('e2e_test (dev basics + storage/photo round-trip)');
    const { app, win, testRoot, consoleErrors } = await launch();

    const basics = await win.evaluate(() => ({
        isElectron: window.isElectron === true,
        hasElectronStorage: !!window.electronStorage,
        hasElectronPhotos: !!window.electronPhotos,
        hasElectronSaveFolder: !!window.electronSaveFolder,
        title: document.title,
        stopCount: (typeof tourData !== 'undefined') ? tourData.length : -1
    }));
    t.ok(basics.isElectron, 'window.isElectron is true');
    t.ok(basics.hasElectronStorage && basics.hasElectronPhotos && basics.hasElectronSaveFolder, 'preload APIs are exposed');
    t.ok(basics.stopCount > 0, `tourData is populated (${basics.stopCount} stops)`);

    await win.evaluate(() => dismissOnboarding());

    // 1) File-backed storage actually round-trips through appStorage
    const storageTest = await win.evaluate(() => {
        currentActiveCityId = 'williamsport';
        state.completedCities.push('williamsport');
        state.cityDetails['williamsport'] = { notes: 'Electron save test', favorite: true };
        const ok = saveState();
        return { ok, completed: state.completedCities.slice() };
    });
    t.ok(storageTest.ok, 'saveState() reports success');
    t.ok(storageTest.completed.includes('williamsport'), 'in-memory state reflects the completed city');

    const saveFolder = await win.evaluate(() => window.electronSaveFolder.get());
    t.eq(saveFolder, path.join(testRoot, 'save'), 'save folder resolves inside the isolated test root');
    const saveDataPath = path.join(saveFolder, 'save-data.json');
    const saveDataOnDisk = fs.existsSync(saveDataPath) ? JSON.parse(fs.readFileSync(saveDataPath, 'utf8')) : null;
    t.ok(!!saveDataOnDisk, 'save-data.json actually exists on disk');
    t.ok(!!saveDataOnDisk && saveDataOnDisk.completedCities.includes('williamsport'), 'completed city persisted to disk');

    // 2) Photo storage writes a real image file
    const tinyJpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
    const photoTest = await win.evaluate(async (b64) => {
        const dataUri = 'data:image/jpeg;base64,' + b64;
        await PhotoStore.set('williamsport', dataUri);
        const back = await PhotoStore.get('williamsport');
        const all = await PhotoStore.all();
        return { roundTripOk: back === dataUri, idsInAll: Object.keys(all) };
    }, tinyJpegBase64);
    t.ok(photoTest.roundTripOk, 'photo round-trips through PhotoStore');
    t.ok(photoTest.idsInAll.includes('williamsport'), 'photo shows up in PhotoStore.all()');
    const photoFiles = fs.readdirSync(path.join(saveFolder, 'photos'));
    t.ok(photoFiles.length === 1, `exactly one real photo file on disk (found ${photoFiles.length})`);

    // 3) Save Location UI in Settings
    const settingsUI = await win.evaluate(async () => {
        toggleSettings();
        await new Promise(r => setTimeout(r, 200));
        const visible = document.getElementById('save-location-section').style.display !== 'none';
        const pathText = document.getElementById('save-folder-path').textContent;
        toggleSettings();
        return { visible, pathText };
    });
    t.ok(settingsUI.visible, 'Save Location section is visible in Settings');
    t.eq(settingsUI.pathText, saveFolder, 'Save Location UI shows the actual save folder path');

    // 4) Full storage line (with photo scan) reflects the real file
    const storageLine = await win.evaluate(async () => { await updateStorageUsage(); return document.getElementById('storage-usage').textContent; });
    t.ok(/\d/.test(storageLine), `storage usage line renders a number ("${storageLine}")`);

    // 5) Achievements land as a real file
    await win.evaluate(() => {
        earnedAchievements.push('first');
        persistAchievements();
    });
    const achvPath = path.join(saveFolder, 'achievements.json');
    const achvOnDisk = fs.existsSync(achvPath) ? JSON.parse(fs.readFileSync(achvPath, 'utf8')) : null;
    t.ok(!!achvOnDisk && achvOnDisk.includes('first'), 'achievements.json persisted to disk');

    t.eq(consoleErrors, [], 'no console errors or uncaught page errors during the run');

    await app.close();
    cleanupTestRoot(testRoot);
    t.finish();
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
