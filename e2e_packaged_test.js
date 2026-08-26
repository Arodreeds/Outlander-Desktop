const path = require('path');
const { launch, cleanupTestRoot, Suite } = require('./e2e_helpers');

(async () => {
    const t = new Suite('e2e_packaged_test (built app smoke test)');
    const platformPaths = {
        darwin: 'dist/mac/Outlander Tour Companion.app/Contents/MacOS/Outlander Tour Companion',
        win32: 'dist/win-unpacked/Outlander Tour Companion.exe',
        linux: 'dist/linux-unpacked/outlander-tour-companion',
    };
    const relativePath = platformPaths[process.platform];
    if (!relativePath) throw new Error(`No packaged build path known for platform "${process.platform}"`);
    const appPath = path.join(__dirname, relativePath);
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
