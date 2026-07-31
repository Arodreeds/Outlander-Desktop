// Covers the failure path of "Check for Updates" that e2e_update_test.js can't
// reach, since that one hits the real (working) GitHub API. Points
// OUTLANDER_TEST_RELEASES_API_URL (main.js) at an address nothing listens on,
// so the real fetchJSON()/https.get() code runs end-to-end and genuinely fails,
// rather than mocking Node internals (Playwright's electronApp.evaluate() runs
// in a bare Node context with no `require`, so module-patching isn't available
// here anyway).
const { launch, cleanupTestRoot, Suite } = require('./e2e_helpers');

(async () => {
    const t = new Suite('e2e_update_failure_test (Check for Updates, unreachable API)');
    const { app, win, testRoot, consoleErrors } = await launch({
        extraEnv: { OUTLANDER_TEST_RELEASES_API_URL: 'https://127.0.0.1:39999/releases/latest' }
    });

    await win.evaluate(() => dismissOnboarding());
    await win.evaluate(async () => { toggleSettings(); await new Promise(r => setTimeout(r, 200)); });

    await win.evaluate(() => checkForUpdates());
    await new Promise(r => setTimeout(r, 1500));
    const statusText = await win.evaluate(() => document.getElementById('update-status').textContent);
    t.ok(/couldn't check/i.test(statusText), `unreachable API shows a graceful message, not a crash ("${statusText}")`);

    // The app itself must stay usable after the failure — Settings (already open, from
    // above) still closes cleanly, proving the UI isn't stuck.
    const stillFunctional = await win.evaluate(() => {
        toggleSettings();
        return !document.getElementById('settings-overlay').classList.contains('active');
    });
    t.ok(stillFunctional, 'app remains interactive after a failed update check');

    t.eq(consoleErrors, [], 'no console errors or uncaught page errors during the run');

    await app.close();
    cleanupTestRoot(testRoot);
    t.finish();
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
