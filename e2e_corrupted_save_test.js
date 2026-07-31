// loadState() (index.html) is supposed to fall back to a fresh, well-formed
// state whenever save-data.json can't be parsed into something usable —
// covers a save file truncated by a crash mid-write, or hand-edited into
// something invalid. Neither scenario was exercised by the existing tests.
const fs = require('fs');
const path = require('path');
const { launch, makeTestRoot, cleanupTestRoot, Suite } = require('./e2e_helpers');

async function runCase(t, label, fileContent) {
    const testRoot = makeTestRoot();
    const saveDir = path.join(testRoot, 'save');
    fs.mkdirSync(saveDir, { recursive: true });
    if (fileContent !== null) fs.writeFileSync(path.join(saveDir, 'save-data.json'), fileContent);

    const { app, win, consoleErrors } = await launch({ testRoot });

    const result = await win.evaluate(() => ({
        completedCities: state.completedCities,
        cityDetailsIsObject: typeof state.cityDetails === 'object' && state.cityDetails !== null,
        settingsHasVolume: typeof state.settings.volume === 'number',
        stopCount: tourData.length
    }));
    t.ok(Array.isArray(result.completedCities) && result.completedCities.length === 0, `[${label}] falls back to an empty completedCities array`);
    t.ok(result.cityDetailsIsObject, `[${label}] cityDetails falls back to an object`);
    t.ok(result.settingsHasVolume, `[${label}] settings get normalized defaults`);
    t.ok(result.stopCount > 0, `[${label}] the rest of the app still renders (tourData populated)`);

    // The app should still be usable, not just alive: complete a city and save.
    const stillWritable = await win.evaluate(() => {
        state.completedCities.push('williamsport');
        return saveState();
    });
    t.ok(stillWritable, `[${label}] saveState() still works after recovering from a bad file`);

    t.eq(consoleErrors, [], `[${label}] no console errors or uncaught page errors`);

    await app.close();
    cleanupTestRoot(testRoot);
}

(async () => {
    const t = new Suite('e2e_corrupted_save_test (malformed save-data.json recovery)');

    await runCase(t, 'truncated JSON', '{"completedCities":["williamsport"'); // cut off mid-write
    await runCase(t, 'empty file', '');
    await runCase(t, 'JSON null', 'null');
    await runCase(t, 'JSON scalar', '42');
    await runCase(t, 'binary garbage', Buffer.from([0x00, 0xff, 0x13, 0x37, 0xde, 0xad]));

    t.finish();
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
