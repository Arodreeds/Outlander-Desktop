// promptAndChangeSaveFolder() (main.js) — migrates save-data.json, photos, and
// receipts into a newly-chosen folder. Never exercised before because it's
// driven by a native OS folder picker; Playwright can't click that dialog,
// but electronApp.evaluate() runs in the main process, so we can monkeypatch
// dialog.showOpenDialog directly (dialog is the same cached module object
// main.js already imported) and drive the real IPC handler behind it.
const fs = require('fs');
const path = require('path');
const { launch, makeTestRoot, cleanupTestRoot, Suite } = require('./e2e_helpers');

async function stubDialog(app, result) {
    await app.evaluate(({ dialog }, r) => {
        dialog.showOpenDialog = async () => r;
    }, result);
}

(async () => {
    const t = new Suite('e2e_save_folder_test (Change Save Folder + data migration)');
    const testRoot = makeTestRoot();
    const { app, win, testRoot: root } = await launch({ testRoot });

    const originalFolder = await win.evaluate(() => window.electronSaveFolder.get());

    // Seed some real data in the original folder: a completed city + a photo + a receipt.
    const tinyJpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
    await win.evaluate(async (b64) => {
        state.completedCities.push('williamsport');
        state.cityDetails['williamsport'] = { notes: 'before the move', favorite: true };
        saveState();
        await PhotoStore.set('williamsport', 'data:image/jpeg;base64,' + b64);
        await ReceiptStore.add('williamsport', 'data:image/jpeg;base64,' + b64);
    }, tinyJpegBase64);

    // --- Case 1: user cancels the picker — nothing should change ---
    await stubDialog(app, { canceled: true, filePaths: [] });
    const cancelResult = await win.evaluate(() => window.electronSaveFolder.choose());
    t.ok(cancelResult.changed === false, 'canceling the folder picker reports changed:false');
    t.eq(cancelResult.saveFolder, originalFolder, 'save folder is unchanged after canceling');

    // --- Case 2: user picks a real new folder — data should migrate ---
    const newFolder = path.join(root, 'moved-save-folder');
    await stubDialog(app, { canceled: false, filePaths: [newFolder] });
    const moveResult = await win.evaluate(() => window.electronSaveFolder.choose());
    t.ok(moveResult.changed === true, 'picking a new folder reports changed:true');
    t.eq(moveResult.saveFolder, newFolder, 'reported save folder matches the picked folder');

    const newSaveData = JSON.parse(fs.readFileSync(path.join(newFolder, 'save-data.json'), 'utf8'));
    t.ok(newSaveData.completedCities.includes('williamsport'), 'save-data.json was copied into the new folder');
    const newPhotos = fs.existsSync(path.join(newFolder, 'photos')) ? fs.readdirSync(path.join(newFolder, 'photos')) : [];
    t.ok(newPhotos.length === 1, `photo was copied into the new folder (found ${newPhotos.length})`);
    const newReceiptsCityDir = path.join(newFolder, 'receipts', 'williamsport');
    const newReceipts = fs.existsSync(newReceiptsCityDir) ? fs.readdirSync(newReceiptsCityDir) : [];
    t.ok(newReceipts.length === 1, `receipt was copied into the new folder (found ${newReceipts.length})`);

    // Original folder's data should be left in place, not deleted (a move is a copy, not a cut).
    const originalStillHasData = fs.existsSync(path.join(originalFolder, 'save-data.json'));
    t.ok(originalStillHasData, 'original folder is left intact (copy, not move)');

    // The app now reports and writes to the new folder going forward.
    const currentFolder = await win.evaluate(() => window.electronSaveFolder.get());
    t.eq(currentFolder, newFolder, 'get-save-folder now returns the new folder');
    const postMoveWriteOk = await win.evaluate(() => {
        state.cityDetails['williamsport'].notes = 'after the move';
        return saveState();
    });
    t.ok(postMoveWriteOk, 'writes after the move succeed');
    const postMoveSaveData = JSON.parse(fs.readFileSync(path.join(newFolder, 'save-data.json'), 'utf8'));
    t.eq(postMoveSaveData.cityDetails.williamsport.notes, 'after the move', 'post-move writes land in the new folder, not the old one');

    // --- Case 3: re-picking the exact same (new) folder is a no-op ---
    await stubDialog(app, { canceled: false, filePaths: [newFolder] });
    const samefolderResult = await win.evaluate(() => window.electronSaveFolder.choose());
    t.ok(samefolderResult.changed === false, 'picking the already-active folder again reports changed:false');

    await app.close();
    cleanupTestRoot(testRoot);
    t.finish();
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
