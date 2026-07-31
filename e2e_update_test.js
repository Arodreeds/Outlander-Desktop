const { launch, cleanupTestRoot, Suite } = require('./e2e_helpers');

(async () => {
    const t = new Suite('e2e_update_test (Check for Updates, real network)');
    const { app, win, testRoot, consoleErrors } = await launch();

    await win.evaluate(() => dismissOnboarding());

    // Open Settings and confirm the Updates section is visible (gated on window.electronUpdater).
    const sectionVisible = await win.evaluate(async () => {
        toggleSettings();
        await new Promise(r => setTimeout(r, 200));
        return document.getElementById('update-section').style.display !== 'none';
    });
    t.ok(sectionVisible, 'Updates section is visible in Settings');

    // Click "Check for Updates" — hits the real GitHub Releases API.
    await win.evaluate(() => checkForUpdates());
    await new Promise(r => setTimeout(r, 2500)); // network round trip
    const statusText = await win.evaluate(() => document.getElementById('update-status').textContent);
    t.ok(statusText.length > 0, `status text was populated ("${statusText}")`);
    t.ok(!/undefined|NaN/.test(statusText), `status text has no undefined/NaN artifacts ("${statusText}")`);

    // Confirm the "View on GitHub" button is wired to the exposed API (don't actually invoke
    // it — that would pop a real browser window during an automated test).
    const openReleasePageIsFn = await win.evaluate(() => typeof window.electronUpdater.openReleasePage === 'function');
    t.ok(openReleasePageIsFn, 'electronUpdater.openReleasePage is exposed as a function');

    await win.evaluate(() => toggleSettings());

    t.eq(consoleErrors, [], 'no console errors or uncaught page errors during the run');

    await app.close();
    cleanupTestRoot(testRoot);
    t.finish();
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
