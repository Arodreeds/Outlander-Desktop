// Full start-to-finish feature pass, ahead of a version bump / build.
//
// e2e_test.js and friends already cover storage plumbing (IPC round-trips,
// migration, corrupted saves, save-folder moves, update checks). This file
// instead drives the actual app-level features a user touches — the city
// panel, search, timeline filters, favorites, achievements, exports/import,
// settings, and marking a show complete end-to-end (including the Saxbyte
// walk) — asserting on the real DOM/state, not just the storage layer.
//
// window.print() (exportPDF, exportTimeline) is deliberately not invoked —
// it opens a native OS dialog that would hang a headless run. buildPDFReport()
// is exercised directly instead, since that's the actual report-building logic.
const path = require('path');
const { launch, cleanupTestRoot, Suite } = require('./e2e_helpers');

// All the export functions build a Blob/data: URL, stick it on a throwaway
// <a download>, and click it — real-download plumbing (OS save dialogs,
// Chromium's download manager) that a headless run has no business exercising.
// Intercepting HTMLAnchorElement.prototype.click captures what the app handed
// off without depending on that plumbing actually firing (not guaranteed for
// data: URLs, and just adds flakiness for blob: ones — the original
// 'download'-event version hung on exactly this).
//
// Most of these exports call URL.revokeObjectURL() synchronously right after
// a.click() (only exportData() delays it) — by the time an async fetch(href)
// would run, the blob: URL is already dead. So the Blob object itself is
// captured too, via URL.createObjectURL: revoking a URL only unregisters that
// string, it doesn't touch the Blob value, which stays readable regardless.
async function captureAnchorDownload(win, callExpr) {
    return win.evaluate(async (expr) => {
        let href = null, filename = null, capturedBlob = null;
        const origClick = HTMLAnchorElement.prototype.click;
        const origCreateObjectURL = URL.createObjectURL;
        HTMLAnchorElement.prototype.click = function () { href = this.href; filename = this.download; };
        URL.createObjectURL = function (blob) { capturedBlob = blob; return origCreateObjectURL.call(URL, blob); };
        try {
            // eslint-disable-next-line no-eval
            await eval(expr);
        } finally {
            HTMLAnchorElement.prototype.click = origClick;
            URL.createObjectURL = origCreateObjectURL;
        }
        let text = null;
        if (capturedBlob) {
            text = await capturedBlob.text();
        } else if (href && href.startsWith('data:')) {
            const comma = href.indexOf(',');
            const meta = href.slice(5, comma);
            const payload = href.slice(comma + 1);
            text = meta.includes('base64') ? atob(payload) : decodeURIComponent(payload);
        }
        return { filename, text, href };
    }, callExpr);
}

// Backstop against any single step hanging forever (seen once already, tracked
// down to awaiting an in-page listener across a location.reload() navigation —
// fixed below, but this keeps a *future* hang from costing unbounded wall-clock
// time instead of a bounded, loud failure). unref()'d so it never delays a
// normal finish; step() logs progress so a timeout says which step stuck.
const watchdog = setTimeout(() => {
    console.error(`WATCHDOG: stuck at step "${currentStep}" for 90s — forcing exit`);
    process.exit(1);
}, 90000);
watchdog.unref();
let currentStep = 'startup';
function step(name) { currentStep = name; console.log(`-- ${name}`); }

(async () => {
    const t = new Suite('e2e_feature_smoke_test (full feature pass)');
    step('launch()');
    const { app, win, testRoot, consoleErrors } = await launch();

    await win.evaluate(() => { dismissOnboarding(); window.confirm = () => true; });

    const basics = await win.evaluate(() => ({ stopCount: tourData.length, firstId: tourData[0].id, secondId: tourData[1].id, firstState: tourData[0].stateId }));
    t.ok(basics.stopCount > 1, `tourData populated (${basics.stopCount} stops)`);

    // ---------------- SEARCH ----------------
    step('SEARCH');
    const search = await win.evaluate((firstId) => {
        const stop = tourData.find(s => s.id === firstId);
        const query = stop.city.split(',')[0].slice(0, 4);
        const input = document.getElementById('search-input');
        input.value = query;
        filterCities(query);
        const items = Array.from(document.querySelectorAll('.timeline-item'));
        const matchDimmed = items.find(it => it.dataset.id === firstId).classList.contains('dim-search');
        clearSearch();
        const afterClear = items.every(it => !it.classList.contains('dim-search'));
        return { matchDimmed, afterClear, clearBtnHidden: document.getElementById('search-clear').style.display === 'none' };
    }, basics.firstId);
    t.ok(!search.matchDimmed, 'searching for the first stop\'s own name does not dim it out');
    t.ok(search.afterClear, 'clearSearch() removes all dim-search classes');
    t.ok(search.clearBtnHidden, 'clearSearch() hides the clear button');

    // ---------------- TIMELINE FILTERS ----------------
    step('TIMELINE FILTERS');
    const filters = await win.evaluate(() => {
        setTimelineFilter('fav');
        const noneShownYet = document.querySelectorAll('.timeline-item:not(.filter-hidden)').length === 0;
        setTimelineFilter('all');
        const allShown = document.querySelectorAll('.timeline-item.filter-hidden').length === 0;
        return { noneShownYet, allShown };
    });
    t.ok(filters.noneShownYet, '"fav" filter hides every item when nothing is favorited yet');
    t.ok(filters.allShown, '"all" filter shows every item again');

    // ---------------- SETTINGS: instruments (needed for the instrument checklist below) ----------------
    step('SETTINGS: instruments (needed for the instrument checklist below)');
    await win.evaluate(() => {
        document.getElementById('settings-instrument-input').value = 'Clarinet';
        addSettingsInstrument();
    });
    const instrumentAdded = await win.evaluate(() => state.profile.instruments.includes('Clarinet'));
    t.ok(instrumentAdded, 'adding an instrument in Settings updates state.profile.instruments');

    // ---------------- CITY PANEL: fill every field, save, close, reopen, verify persistence ----------------
    step('CITY PANEL: fill every field, save, close, reopen, verify persistence');
    const cityId = basics.firstId;
    await win.evaluate((id) => openCityPanel(id), cityId);
    await win.evaluate(() => {
        document.getElementById('panel-time-input').value = '8:00 PM';
        document.getElementById('panel-notes').value = 'Great show, met the band.';
        document.getElementById('panel-favorite').checked = true;
        document.getElementById('exp-equipment').value = '40';
        document.getElementById('exp-food').value = '25';
        document.getElementById('exp-drink').value = '15';
        document.getElementById('exp-budget').value = '200';
        document.getElementById('panel-expense-notes').value = 'Parking + merch';
        document.querySelector('.social-check[value="reel"]').checked = true;
        updateSocialNoteVisibility();
        document.getElementById('panel-social-note').value = 'Posted a reel from soundcheck';
        const instCheck = document.querySelector('.inst-log-check[data-instrument="Clarinet"]');
        instCheck.checked = true;
        instCheck.dispatchEvent(new Event('change'));
        document.querySelector('.inst-log-note[data-instrument="Clarinet"]').value = 'Swapped two reeds';
        saveCityData(false);
    });
    await win.evaluate(() => closeCityPanel());
    await win.evaluate((id) => openCityPanel(id), cityId);
    await new Promise(r => setTimeout(r, 150)); // let async renderReceipts()/PhotoStore.get() inside openCityPanel settle
    const reopened = await win.evaluate(() => ({
        time: document.getElementById('panel-time-input').value,
        notes: document.getElementById('panel-notes').value,
        favorite: document.getElementById('panel-favorite').checked,
        equipment: document.getElementById('exp-equipment').value,
        expenseNotes: document.getElementById('panel-expense-notes').value,
        socialReel: document.querySelector('.social-check[value="reel"]').checked,
        socialNoteVisible: document.getElementById('panel-social-note-wrap').style.display !== 'none',
        socialNote: document.getElementById('panel-social-note').value,
        instChecked: document.querySelector('.inst-log-check[data-instrument="Clarinet"]').checked,
        instNote: document.querySelector('.inst-log-note[data-instrument="Clarinet"]').value,
        budgetBarShown: document.getElementById('panel-budget-bar-track').style.display !== 'none'
    }));
    t.eq(reopened.time, '8:00 PM', 'showtime persists across close/reopen');
    t.eq(reopened.notes, 'Great show, met the band.', 'personal notes persist across close/reopen');
    t.ok(reopened.favorite, 'favorite checkbox persists across close/reopen');
    t.eq(reopened.equipment, '40', 'equipment expense persists across close/reopen');
    t.eq(reopened.expenseNotes, 'Parking + merch', 'expense notes persist across close/reopen');
    t.ok(reopened.socialReel, 'social checklist (IG Reel) persists across close/reopen');
    t.ok(reopened.socialNoteVisible, 'social note textarea stays visible when a social box is checked');
    t.eq(reopened.socialNote, 'Posted a reel from soundcheck', 'social note text persists across close/reopen');
    t.ok(reopened.instChecked, 'instrument checklist checkbox persists across close/reopen');
    t.eq(reopened.instNote, 'Swapped two reeds', 'instrument log note persists across close/reopen');
    t.ok(reopened.budgetBarShown, 'budget bar appears once a budget target is set');

    // ---------------- PHOTO (panel preview reflects PhotoStore) ----------------
    step('PHOTO (panel preview reflects PhotoStore)');
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await win.evaluate(async ({ id, uri }) => { await PhotoStore.set(id, uri); }, { id: cityId, uri: tinyPng });
    await win.evaluate((id) => openCityPanel(id), cityId);
    await new Promise(r => setTimeout(r, 150));
    const photoShown = await win.evaluate(() => document.getElementById('panel-photo-preview').style.backgroundImage.includes('data:image/png'));
    t.ok(photoShown, 'a photo set via PhotoStore shows up in the panel preview on reopen');

    // ---------------- RECEIPTS ----------------
    step('RECEIPTS');
    const tinyJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
    await win.evaluate(async ({ id, uri }) => { await ReceiptStore.add(id, uri); await renderReceipts(id); }, { id: cityId, uri: tinyJpeg });
    const receiptShown = await win.evaluate(() => document.querySelectorAll('#panel-receipts .receipt-thumb').length);
    t.eq(receiptShown, 1, 'an uploaded receipt renders a thumbnail in the panel');
    const reviewPanel = await win.evaluate(async (id) => {
        await openReceiptsReview();
        return document.getElementById('receipts-review-content').innerHTML.includes(tourData.find(s => s.id === id).city.split(',')[0]);
    }, cityId);
    t.ok(reviewPanel, 'Receipts review panel (More menu) lists the city with a receipt');
    await win.evaluate(() => closePanel('receipts-overlay'));

    // ---------------- MARK COMPLETE: achievements, dashboard, walk, backup nudge ----------------
    step('MARK COMPLETE: achievements, dashboard, walk, backup nudge');
    await win.evaluate((id) => openCityPanel(id), cityId);
    const beforeComplete = await win.evaluate(() => ({ shows: document.getElementById('stat-shows').textContent, completed: state.completedCities.length }));
    await win.evaluate(() => toggleCityCompletion());
    const afterComplete = await win.evaluate((id) => ({
        completed: state.completedCities.includes(id),
        shows: document.getElementById('stat-shows').textContent,
        firstAchievement: earnedAchievements.includes('first'),
        pendingWalk: startWalkAfterPanelCloses || pendingWalkRouteId !== null || walkTargetId !== null
    }), cityId);
    t.ok(afterComplete.completed, 'toggleCityCompletion() marks the city as completed');
    t.ok(afterComplete.shows !== beforeComplete.shows, 'dashboard "Shows" stat updates after marking a show complete');
    t.ok(afterComplete.firstAchievement, '"first show" achievement is awarded on the first completion');
    t.ok(afterComplete.pendingWalk, 'completing a show queues up Saxbyte\'s walk to the next stop');
    // Give the walk (kicked off PANEL_CLOSE_MS after the panel closes) a moment to actually start.
    await new Promise(r => setTimeout(r, 700));
    const walking = await win.evaluate(() => document.getElementById('travel-hud').classList.contains('show'));
    t.ok(walking, 'Saxbyte\'s walk actually starts (travel HUD shows) after completing a show');
    await win.evaluate(() => cancelWalk()); // don't burn wall-clock time waiting out the full animation

    // ---------------- MAINTENANCE LOG (instrument notes) ----------------
    step('MAINTENANCE LOG (instrument notes)');
    // Only shows notes for *completed* stops, so this has to run before the
    // un-mark step just below clears that flag again.
    const maint = await win.evaluate(() => {
        openMaintenanceLog();
        const hasEntry = document.getElementById('maintenance-list').innerHTML.includes('Swapped two reeds');
        closePanel('maintenance-overlay');
        return hasEntry;
    });
    t.ok(maint, 'Maintenance Log lists the instrument note logged on a completed stop');

    // Un-mark it again (sequential cascade shouldn't trigger — nothing later is completed).
    await win.evaluate((id) => openCityPanel(id), cityId);
    await win.evaluate(() => toggleCityCompletion());
    const afterUnmark = await win.evaluate((id) => state.completedCities.includes(id), cityId);
    t.ok(!afterUnmark, 'toggleCityCompletion() un-marks a completed city');

    // ---------------- FAVORITES PANEL ----------------
    step('FAVORITES PANEL');
    const favPanel = await win.evaluate((id) => {
        openFavorites();
        const listedWhileFav = document.getElementById('favorites-list').innerHTML.includes(tourData.find(s => s.id === id).city.split(',')[0]);
        closePanel('favorites-overlay');
        toggleFavoriteQuick(id);
        openFavorites();
        const listedAfterUnfav = document.getElementById('favorites-list').innerHTML.includes(tourData.find(s => s.id === id).city.split(',')[0]);
        closePanel('favorites-overlay');
        return { listedWhileFav, listedAfterUnfav, stillFav: state.cityDetails[id].favorite };
    }, cityId);
    t.ok(favPanel.listedWhileFav, 'Favorites panel lists a city marked favorite');
    t.ok(!favPanel.stillFav && !favPanel.listedAfterUnfav, 'toggleFavoriteQuick() unfavorites and the panel reflects it');

    // ---------------- ACHIEVEMENTS PANEL ----------------
    step('ACHIEVEMENTS PANEL');
    const achv = await win.evaluate(() => {
        openAchievements();
        const tally = document.getElementById('achv-tally').textContent;
        const gotFirst = document.getElementById('achv-list').innerHTML.includes('got');
        closePanel('achievements-overlay');
        return { tally, gotFirst };
    });
    t.ok(/^[1-9]/.test(achv.tally), `achievements tally shows at least one earned (${achv.tally})`);
    t.ok(achv.gotFirst, 'achievements list visually marks at least one earned achievement');

    // ---------------- STATE PANEL ----------------
    step('STATE PANEL');
    const statePanel = await win.evaluate((abbr) => {
        openStatePanelFor(abbr);
        const active = document.getElementById('state-overlay').classList.contains('active');
        const summaryFilled = document.getElementById('state-summary').innerHTML.trim().length > 0;
        closePanel('state-overlay');
        return { active, summaryFilled };
    }, basics.firstState);
    t.ok(statePanel.active && statePanel.summaryFilled, `State panel opens and renders a summary for ${basics.firstState}`);

    // ---------------- GALLERY ----------------
    step('GALLERY');
    const gallery = await win.evaluate(async () => {
        await openGallery();
        const hasPhoto = document.getElementById('gallery-content').querySelectorAll('img').length > 0;
        closePanel('gallery-overlay');
        return hasPhoto;
    });
    t.ok(gallery, 'Gallery shows the photo uploaded earlier');

    // ---------------- RECAP ----------------
    step('RECAP');
    const recap = await win.evaluate(() => {
        openRecap();
        const n = recapNumbers();
        const cardFilled = document.getElementById('recap-card').innerHTML.includes('Shows');
        closePanel('recap-overlay');
        return { n, cardFilled };
    });
    t.ok(recap.cardFilled, 'Recap card renders with stats');
    t.ok(Number.isFinite(recap.n.completedCount) && Number.isFinite(recap.n.miles) && Number.isFinite(recap.n.spent), 'recapNumbers() returns numeric totals');
    const recapImg = await captureAnchorDownload(win, "downloadRecapImage()");
    t.eq(recapImg.filename, 'outlander_tour_recap.png', 'downloadRecapImage() produces a PNG download');
    t.ok(recapImg.text.length > 0, 'recap image download has actual bytes');

    // ---------------- SETTINGS: palette / pace / map style / travel lines / sequential ----------------
    step('SETTINGS: palette / pace / map style / travel lines / sequential');
    const settingsSweep = await win.evaluate(() => {
        const palSel = document.getElementById('set-palette');
        palSel.value = 'day'; palSel.dispatchEvent(new Event('change'));
        const dayNight = getComputedStyle(document.documentElement).getPropertyValue('--night').trim();

        const paceSel = document.getElementById('set-pace');
        paceSel.value = 'brisk'; paceSel.dispatchEvent(new Event('change'));
        const briskMs = TRAVEL_MS;

        const mapSel = document.getElementById('set-mapstyle');
        mapSel.value = 'modern'; mapSel.dispatchEvent(new Event('change'));
        const modernOn = document.body.classList.contains('map-style-modern');

        toggleTravelLines();
        const linesHidden = document.getElementById('map-container').classList.contains('hide-travel-lines');
        toggleTravelLines();
        const linesRestored = !document.getElementById('map-container').classList.contains('hide-travel-lines');

        const seqBox = document.getElementById('set-sequential');
        seqBox.checked = false; seqBox.dispatchEvent(new Event('change'));
        const seqOff = state.settings.sequential === false;
        seqBox.checked = true; seqBox.dispatchEvent(new Event('change'));

        // The slider's actual value-setting lives on 'input' (setVolume()); 'change'
        // only saves/previews once dragging ends — same as a real drag gesture.
        const volSlider = document.getElementById('set-volume');
        volSlider.value = '30'; volSlider.dispatchEvent(new Event('input'));
        volSlider.dispatchEvent(new Event('change'));

        return { dayNight, briskMs, modernOn, linesHidden, linesRestored, seqOff, palette: state.settings.palette, volume: state.settings.volume };
    });
    t.eq(settingsSweep.dayNight, '#f6f1e4', 'switching to the Day palette applies its CSS variables');
    t.eq(settingsSweep.palette, 'day', 'palette setting persists to state');
    t.eq(settingsSweep.briskMs, 3200, 'switching Journey Pace to Brisk updates TRAVEL_MS');
    t.ok(settingsSweep.modernOn, 'switching Map Style to Modern toggles the body class');
    t.ok(settingsSweep.linesHidden, 'toggling travel lines off hides them');
    t.ok(settingsSweep.linesRestored, 'toggling travel lines back on restores them');
    t.ok(settingsSweep.seqOff, 'turning off "Require shows in order" updates the setting');
    t.eq(settingsSweep.volume, 30, 'volume slider change updates state.settings.volume');

    // ---------------- EXPORTS ----------------
    step('EXPORTS');
    const backup = await captureAnchorDownload(win, "exportData()");
    t.eq(backup.filename, 'tour_companion_backup.json', 'exportData() downloads the expected filename');
    let backupJson;
    try { backupJson = JSON.parse(backup.text); } catch (e) { backupJson = null; }
    t.ok(!!backupJson, 'exported backup is valid JSON');
    t.ok(!!backupJson && Array.isArray(backupJson.state.completedCities) && backupJson.state.cityDetails, 'exported backup has the expected shape (state.completedCities/cityDetails)');

    const csv = await captureAnchorDownload(win, "exportCSV()");
    t.eq(csv.filename, 'tour_companion_data.csv', 'exportCSV() downloads the expected filename');
    t.ok(csv.text.startsWith('City,State,Venue'), 'CSV export starts with the expected header row');

    const ics = await captureAnchorDownload(win, "exportTourICS()");
    t.ok(ics.text.includes('BEGIN:VCALENDAR'), 'Tour calendar export is a valid ICS file');
    t.eq((ics.text.match(/BEGIN:VEVENT/g) || []).length, basics.stopCount, 'Tour calendar export has one VEVENT per stop');

    await win.evaluate((id) => { currentActiveCityId = id; }, cityId);
    const oneShowIcs = await captureAnchorDownload(win, "addShowToCalendar()");
    t.ok(oneShowIcs.text.includes('BEGIN:VEVENT') && (oneShowIcs.text.match(/BEGIN:VEVENT/g) || []).length === 1, 'Add-to-Calendar for a single show exports exactly one VEVENT');

    const diary = await captureAnchorDownload(win, "exportDiary()");
    t.eq(diary.filename, 'outlander-tour-diary.md', 'exportDiary() downloads the expected filename');
    t.ok(diary.text.length > 0, 'diary export produces non-empty markdown');

    const pdfReport = await win.evaluate(async () => {
        const receiptsByCity = await ReceiptStore.all();
        return buildPDFReport(receiptsByCity);
    });
    t.ok(typeof pdfReport === 'string' && pdfReport.length > 0, 'buildPDFReport() renders a non-empty report without invoking the print dialog');

    // ---------------- IMPORT (round trip a mutated backup back in) ----------------
    step('IMPORT (round trip a mutated backup back in)');
    // importData() ends in location.reload() on success. Awaiting an in-page
    // listener (window.addEventListener('load', ...)) from *inside* the same
    // evaluate() call that triggers that reload is a real hang risk — the
    // navigation can tear down the execution context that promise lives in
    // before it resolves. Arm Playwright's own page-level 'load' wait first
    // (survives the context teardown because it's driven from the Node side,
    // not from inside the page), then fire the reload as fire-and-forget.
    let loadPromise = win.waitForEvent('load', { timeout: 15000 });
    await win.evaluate(({ json, id }) => {
        const modified = JSON.parse(json);
        modified.state.cityDetails[id] = { ...(modified.state.cityDetails[id] || {}), notes: 'Imported note ✓' };
        const file = new File([JSON.stringify(modified)], 'backup.json', { type: 'application/json' });
        importData({ target: { files: [file], value: '' } });
    }, { json: backup.text, id: cityId });
    await loadPromise;
    await new Promise(r => setTimeout(r, 300));
    const afterImport = await win.evaluate((id) => (state.cityDetails[id] || {}).notes, cityId);
    t.eq(afterImport, 'Imported note ✓', 'importData() round-trips a mutated backup and survives location.reload()');

    // ---------------- RESET (destructive — last step, throwaway test-root storage) ----------------
    step('RESET (destructive — last step, throwaway test-root storage)');
    await win.evaluate(() => { window.confirm = () => true; resetTour(); });
    const dialogOpen = await win.evaluate(() => document.getElementById('reset-dialog').classList.contains('show'));
    t.ok(dialogOpen, 'Reset confirmation dialog opens');
    loadPromise = win.waitForEvent('load', { timeout: 15000 });
    await win.evaluate(() => { resetDialogResetAnyway(); });
    await loadPromise;
    await new Promise(r => setTimeout(r, 300));
    const afterReset = await win.evaluate(() => ({ completed: state.completedCities.length, cityDetailCount: Object.keys(state.cityDetails).length }));
    t.eq(afterReset.completed, 0, 'Reset Entire Tour Data clears completedCities');
    t.eq(afterReset.cityDetailCount, 0, 'Reset Entire Tour Data clears cityDetails');

    t.eq(consoleErrors, [], 'no console errors or uncaught page errors during the full feature pass');

    await app.close();
    cleanupTestRoot(testRoot);
    t.finish();
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
