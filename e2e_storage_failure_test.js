// A read-only save folder (permission denied, e.g. a synced Dropbox folder
// with a stale lock, or a disk that went full) should degrade gracefully:
// saveState() must report failure and warn the user, not silently claim
// success while nothing is actually written. Uncovered a real bug — see
// the saveState() fix in index.html — so this also guards the fix.
const fs = require('fs');
const path = require('path');
const { launch, cleanupTestRoot, Suite } = require('./e2e_helpers');

(async () => {
    const t = new Suite('e2e_storage_failure_test (read-only save folder)');
    const { app, win, testRoot, consoleErrors } = await launch();

    const saveFolder = await win.evaluate(() => window.electronSaveFolder.get());
    const saveDataPath = path.join(saveFolder, 'save-data.json');

    // Baseline: a normal write succeeds and is reported as such.
    const beforeOk = await win.evaluate(() => saveState());
    t.ok(beforeOk === true, 'a normal write reports success');

    // Make save-data.json itself read-only so the write fails with EACCES. (Directory
    // permissions don't gate overwriting an existing file's content on POSIX — only
    // creating/deleting/renaming entries — so the chmod has to target the file itself.)
    fs.chmodSync(saveDataPath, 0o444);
    try {
        const writeResult = await win.evaluate(() => {
            state.cityDetails['williamsport'] = { notes: 'should not persist', favorite: true };
            return saveState();
        });
        t.ok(writeResult === false, 'saveState() reports failure when the disk write fails');

        const toastShown = await win.evaluate(() => {
            const toasts = document.querySelectorAll('.toast, [class*="toast"]');
            return Array.from(toasts).some(el => /storage full/i.test(el.textContent || ''));
        });
        t.ok(toastShown, 'a "Storage full" warning is shown to the user');

        // The file on disk must NOT reflect the failed write — no silent partial/stale success.
        const onDiskAfter = fs.existsSync(saveDataPath) ? JSON.parse(fs.readFileSync(saveDataPath, 'utf8')) : {};
        t.ok(!onDiskAfter.cityDetails || !onDiskAfter.cityDetails.williamsport, 'the failed write did not land on disk');
    } finally {
        // Always restore write access before cleanup, or rmSync on the test root will fail too.
        fs.chmodSync(saveDataPath, 0o644);
    }

    // Once writable again, saves should succeed normally — no lingering broken state.
    const afterOk = await win.evaluate(() => saveState());
    t.ok(afterOk === true, 'writes succeed again once the folder is writable');

    // console.warn from the caught error is expected and fine; only real errors/pageerrors count.
    t.eq(consoleErrors, [], 'no console errors or uncaught page errors during the run');

    await app.close();
    cleanupTestRoot(testRoot);
    t.finish();
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
