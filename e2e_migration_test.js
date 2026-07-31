// migrateCityDetails() (index.html) rewrites pre-1.x save data in place:
// expenses.gas -> expenses.equipment, expenses.lodging -> expenses.drink,
// and backfills instrumentLogs. No existing test ever fed it an old-format
// save, so a regression here would only surface as silently-wrong numbers
// in someone's real budget total.
const fs = require('fs');
const path = require('path');
const { launch, makeTestRoot, cleanupTestRoot, Suite } = require('./e2e_helpers');

(async () => {
    const t = new Suite('e2e_migration_test (legacy expenses schema)');

    const testRoot = makeTestRoot();
    const saveDir = path.join(testRoot, 'save');
    fs.mkdirSync(saveDir, { recursive: true });

    const legacySave = {
        completedCities: ['williamsport'],
        cityDetails: {
            williamsport: {
                notes: 'old-format save',
                favorite: true,
                expenses: { gas: 25, lodging: 60, food: 15 }
                // no instrumentLogs — predates that feature
            }
        },
        dragonflyFound: false,
        profile: { name: 'Legacy Tester', instruments: [] },
        settings: { sounds: true } // predates volume/interactSound/etc.
    };
    fs.writeFileSync(path.join(saveDir, 'save-data.json'), JSON.stringify(legacySave));

    const { app, win, consoleErrors } = await launch({ testRoot });

    const migrated = await win.evaluate(() => state.cityDetails.williamsport);
    t.ok(migrated !== undefined, 'the pre-existing city detail survived migration');
    t.eq(migrated.expenses.equipment, 25, 'expenses.gas migrated to expenses.equipment');
    t.eq(migrated.expenses.drink, 60, 'expenses.lodging migrated to expenses.drink');
    t.eq(migrated.expenses.food, 15, 'untouched expense field (food) is preserved');
    t.ok(!('gas' in migrated.expenses), 'old expenses.gas key is removed');
    t.ok(!('lodging' in migrated.expenses), 'old expenses.lodging key is removed');
    t.ok(typeof migrated.instrumentLogs === 'object' && migrated.instrumentLogs !== null, 'missing instrumentLogs backfilled to an object');
    t.eq(migrated.notes, 'old-format save', 'unrelated fields (notes) are untouched by migration');

    const settings = await win.evaluate(() => state.settings);
    t.ok(typeof settings.volume === 'number', 'settings missing volume get a default');
    t.ok(typeof settings.interactSound === 'string', 'settings missing interactSound get a default');

    // Migration must be idempotent — saving and re-loading shouldn't re-migrate or duplicate keys.
    const reSaved = await win.evaluate(() => {
        saveState();
        loadState();
        return state.cityDetails.williamsport;
    });
    t.eq(reSaved.expenses.equipment, 25, 'migration is idempotent across a save/reload cycle');
    t.ok(!('gas' in reSaved.expenses), 'no gas key reappears after a second load');

    t.eq(consoleErrors, [], 'no console errors or uncaught page errors during the run');

    await app.close();
    cleanupTestRoot(testRoot);
    t.finish();
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
