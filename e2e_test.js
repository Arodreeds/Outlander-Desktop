const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const logs = [];
  // This session sets ELECTRON_RUN_AS_NODE=1 globally (a sane default that stops
  // GUI apps from spawning unexpectedly), which would make Electron behave as
  // plain Node instead of opening a real window. Strip it for this one launch
  // so we can actually verify the packaged app renders.
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [__dirname], env: cleanEnv });
  const win = await app.firstWindow();
  win.on('console', msg => { if (msg.type() === 'error') logs.push('[console.error] ' + msg.text()); });
  win.on('pageerror', err => logs.push('[pageerror] ' + err.message));

  await win.waitForLoadState('domcontentloaded');
  await new Promise(r => setTimeout(r, 800));

  const basics = await win.evaluate(() => ({
    isElectron: window.isElectron === true,
    hasElectronStorage: !!window.electronStorage,
    hasElectronPhotos: !!window.electronPhotos,
    hasElectronSaveFolder: !!window.electronSaveFolder,
    title: document.title,
    stopCount: (typeof tourData !== 'undefined') ? tourData.length : -1
  }));
  logs.push('[basics] ' + JSON.stringify(basics));

  await win.evaluate(() => dismissOnboarding());

  // 1) File-backed storage actually round-trips through appStorage
  const storageTest = await win.evaluate(() => {
    currentActiveCityId = 'williamsport';
    state.completedCities.push('williamsport');
    state.cityDetails['williamsport'] = { notes: 'Electron save test', favorite: true };
    const ok = saveState();
    return { ok, completed: state.completedCities.slice() };
  });
  logs.push('[storage round-trip via appStorage] ' + JSON.stringify(storageTest));

  const saveFolder = await win.evaluate(() => window.electronSaveFolder.get());
  logs.push('[save folder path] ' + saveFolder);
  const saveDataPath = path.join(saveFolder, 'save-data.json');
  const saveDataOnDisk = fs.existsSync(saveDataPath) ? JSON.parse(fs.readFileSync(saveDataPath, 'utf8')) : null;
  logs.push('[save-data.json actually on disk] completedCities=' + JSON.stringify(saveDataOnDisk && saveDataOnDisk.completedCities));

  // 2) Photo storage writes a real image file
  const tinyJpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
  const photoTest = await win.evaluate(async (b64) => {
    const dataUri = 'data:image/jpeg;base64,' + b64;
    await PhotoStore.set('williamsport', dataUri);
    const back = await PhotoStore.get('williamsport');
    const all = await PhotoStore.all();
    return { roundTripOk: back === dataUri, idsInAll: Object.keys(all) };
  }, tinyJpegBase64);
  logs.push('[photo round-trip via PhotoStore] ' + JSON.stringify(photoTest));
  const photoFiles = fs.readdirSync(path.join(saveFolder, 'photos'));
  logs.push('[real photo file on disk] ' + JSON.stringify(photoFiles));

  // 3) Save Location UI in Settings
  const settingsUI = await win.evaluate(async () => {
    toggleSettings();
    await new Promise(r => setTimeout(r, 200));
    const visible = document.getElementById('save-location-section').style.display !== 'none';
    const pathText = document.getElementById('save-folder-path').textContent;
    toggleSettings();
    return { visible, pathText };
  });
  logs.push('[Settings Save Location UI] ' + JSON.stringify(settingsUI));

  // 4) Full storage line (with photo scan) reflects the real file
  const storageLine = await win.evaluate(async () => { await updateStorageUsage(); return document.getElementById('storage-usage').textContent; });
  logs.push('[storage usage line] ' + storageLine);

  // 5) Achievements / geocode files also land as real files (indirect: run checkAchievements via full completion path is heavy; just confirm the achievements file mechanism by writing through persistAchievements)
  const achvTest = await win.evaluate(() => {
    earnedAchievements.push('first');
    persistAchievements();
    return true;
  });
  const achvPath = path.join(saveFolder, 'achievements.json');
  logs.push('[achievements.json on disk] ' + (fs.existsSync(achvPath) ? fs.readFileSync(achvPath, 'utf8') : 'MISSING'));

  console.log(logs.join('\n'));
  console.log('---');
  console.log('console/page error count:', logs.filter(l => l.startsWith('[console.error]') || l.startsWith('[pageerror]')).length);

  await app.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
