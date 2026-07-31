const path = require('path');
const { launch, cleanupTestRoot, Suite } = require('./e2e_helpers');

(async () => {
    const t = new Suite('e2e_packaged_test (built .app smoke test)');
    const appPath = path.join(__dirname, 'dist/mac/Outlander Tour Companion.app/Contents/MacOS/Outlander Tour Companion');
    const { app, win, testRoot, consoleErrors } = await launch({ executablePath: appPath });

    const info = await win.evaluate(() => ({
        isElectron: window.isElectron === true,
        title: document.title,
        stopCount: (typeof tourData !== 'undefined') ? tourData.length : -1
    }));
    t.ok(info.isElectron, 'window.isElectron is true in the packaged build');
    t.ok(info.title.length > 0, `document has a title ("${info.title}")`);
    t.ok(info.stopCount > 0, `tourData is populated (${info.stopCount} stops)`);

    await win.screenshot({ path: path.join(__dirname, 'packaged_app_screenshot.png') });

    t.eq(consoleErrors, [], 'no console errors or uncaught page errors during the run');

    await app.close();
    cleanupTestRoot(testRoot);
    t.finish();
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
