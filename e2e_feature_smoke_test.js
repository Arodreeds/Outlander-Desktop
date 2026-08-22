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

    const basics = await win.evaluate(() => ({ stopCount: tourData.length, firstId: tourData[0].id, secondId: tourData[1].id, firstState: tourData[0].stateId, firstMiles: tourData[0].milesToNext }));
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

    // ---------------- RENDER HARDENING (a hostile dataUri — e.g. from a hand-edited or
    // corrupted imported backup — must never become live markup in the receipts/gallery
    // panels; see the statEsc() fix on renderReceipts/openReceiptsReview/openGallery).
    // Can't exercise this via ReceiptStore/PhotoStore directly: window.electronReceipts /
    // window.electronPhotos are contextBridge objects, and Electron deep-freezes those before
    // exposing them (confirmed: Object.isFrozen is true), so a real dataUri can never actually
    // carry HTML metacharacters by the time it round-trips through main.js's file storage
    // (mime is re-derived from a 3-value whitelist, bytes are re-encoded as clean base64) —
    // and the store itself can't be monkey-patched to simulate a dirty value reaching render.
    // So this checks the actual defense directly: the escaping primitive, and that the three
    // fixed render functions still call it on the untrusted field, rather than the injection
    // scenario end-to-end (which the store's own sanitization already makes unreachable). ----------------
    step('RENDER HARDENING (statEsc() neutralizes a hostile dataUri, and is wired into every render site)');
    const hardening = await win.evaluate(() => {
        const evil = '"><img src=x onerror="window.__xssFired=true">';
        const escaped = statEsc(evil);
        return {
            neutralized: !escaped.includes('"') && !escaped.includes('<') && !escaped.includes('>'),
            properEntities: escaped.includes('&quot;') && escaped.includes('&lt;') && escaped.includes('&gt;'),
            receiptsPanelEscaped: renderReceipts.toString().includes('statEsc(r.dataUri)'),
            receiptsReviewEscaped: openReceiptsReview.toString().includes('statEsc(r.dataUri)'),
            galleryEscaped: openGallery.toString().includes('statEsc(photos[stop.id])'),
            // These 7 sites were flagged during this session's health review as unescaped
            // interpolations of stop.city/venue/date/time — "safe" only because tourData used
            // to be 100% hardcoded. "Add a Show" ends that assumption, so every one of them
            // was hardened alongside it; guard against a future edit silently dropping statEsc().
            statePanelEscaped: openStatePanelFor.toString().includes('statEsc(stop.city.split') && openStatePanelFor.toString().includes('statEsc(stop.venue)'),
            timelineEscaped: renderTimeline.toString().includes('statEsc(stop.date)') && renderTimeline.toString().includes('statEsc(stop.city.split') && renderTimeline.toString().includes('statEsc(showtime)'),
            venueMapPopupEscaped: showVenueMap.toString().includes('statEsc(stop.venue)') && showVenueMap.toString().includes('statEsc(stop.city)'),
            receiptsReviewCityEscaped: openReceiptsReview.toString().includes('statEsc(stop.city)') && openReceiptsReview.toString().includes('statEsc(stop.date)') && openReceiptsReview.toString().includes('statEsc(stop.venue)'),
            maintenanceLogEscaped: openMaintenanceLog.toString().includes('statEsc(stop.city)') && openMaintenanceLog.toString().includes('statEsc(stop.venue)') && openMaintenanceLog.toString().includes('statEsc(stop.date)'),
            favoritesEscaped: openFavorites.toString().includes('statEsc(stop.city)') && openFavorites.toString().includes('statEsc(stop.date)') && openFavorites.toString().includes('statEsc(stop.venue)'),
            galleryCityDateEscaped: openGallery.toString().includes('statEsc(stop.city)') && openGallery.toString().includes('statEsc(stop.city.split') && openGallery.toString().includes('statEsc(stop.date)')
        };
    });
    t.ok(hardening.neutralized, 'statEsc() strips the quote/angle-bracket characters a hostile dataUri would need to break out of an <img> attribute');
    t.ok(hardening.properEntities, 'statEsc() output uses proper HTML entities');
    t.ok(hardening.receiptsPanelEscaped, 'renderReceipts() escapes dataUri before writing it into innerHTML');
    t.ok(hardening.receiptsReviewEscaped, 'openReceiptsReview() escapes dataUri before writing it into innerHTML');
    t.ok(hardening.statePanelEscaped, 'openStatePanelFor() escapes city/venue before writing them into innerHTML');
    t.ok(hardening.timelineEscaped, 'renderTimeline() escapes date/city/showtime before writing them into innerHTML');
    t.ok(hardening.venueMapPopupEscaped, "showVenueMap() escapes venue/city before handing them to Leaflet's bindPopup");
    t.ok(hardening.receiptsReviewCityEscaped, 'openReceiptsReview() escapes city/date/venue before writing them into innerHTML');
    t.ok(hardening.maintenanceLogEscaped, 'openMaintenanceLog() escapes city/venue/date before writing them into innerHTML');
    t.ok(hardening.favoritesEscaped, 'openFavorites() escapes city/date/venue before writing them into innerHTML');
    t.ok(hardening.galleryCityDateEscaped, 'openGallery() escapes city/date before writing them into innerHTML');
    t.ok(hardening.galleryEscaped, 'openGallery() escapes the photo dataUri before writing it into innerHTML');
    // The old code opened the full-size receipt via an onclick="window.open('${dataUri}')"
    // string built from unescaped data; it's now a real click listener matched by id instead —
    // confirm that still opens the correct (real, legitimately-uploaded) receipt.
    const receiptClickWiring = await win.evaluate(async () => {
        let opened = null;
        const origOpen = window.open;
        window.open = (uri) => { opened = uri; };
        document.querySelector('#panel-receipts .receipt-thumb img').click();
        window.open = origOpen;
        return opened;
    });
    t.eq(receiptClickWiring, tinyJpeg, 'clicking a receipt thumbnail still opens its real dataUri');

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

    // ---------------- KEYBOARD SHORTCUTS (g/r/f open Gallery/Receipts/Favorites) ----------------
    step('KEYBOARD SHORTCUTS (g/r/f)');
    const shortcuts = await win.evaluate(async () => {
        function pressKey(key, target) {
            (target || document).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        }
        const result = {};
        pressKey('g');
        await new Promise(r => setTimeout(r, 20));
        result.galleryOpened = document.getElementById('gallery-overlay').classList.contains('active');
        closePanel('gallery-overlay');

        pressKey('r');
        await new Promise(r => setTimeout(r, 20));
        result.receiptsOpened = document.getElementById('receipts-overlay').classList.contains('active');
        closePanel('receipts-overlay');

        pressKey('f');
        await new Promise(r => setTimeout(r, 20));
        result.favoritesOpened = document.getElementById('favorites-overlay').classList.contains('active');
        closePanel('favorites-overlay');

        // Typing 'g'/'r'/'f' into a text field must not trigger the shortcut — dispatched on
        // the focused input itself so isTypingTarget(e.target) actually sees it, matching how
        // a real keypress while typing would bubble from the input to the document listener.
        const input = document.getElementById('search-input');
        input.focus();
        pressKey('g', input);
        await new Promise(r => setTimeout(r, 20));
        result.noHijackWhileTyping = !document.getElementById('gallery-overlay').classList.contains('active');
        input.blur();

        return result;
    });
    t.ok(shortcuts.galleryOpened, "'g' opens the Gallery");
    t.ok(shortcuts.receiptsOpened, "'r' opens the Receipts review");
    t.ok(shortcuts.favoritesOpened, "'f' opens Favorites");
    t.ok(shortcuts.noHijackWhileTyping, "'g'/'r'/'f' shortcuts don't fire while typing in the search field");

    // ---------------- ADD A SHOW: click-to-place mechanics ----------------
    step('ADD A SHOW: click-to-place mechanics');
    const placement = await win.evaluate(async () => {
        openAddShow();
        const overlayOpenBefore = document.getElementById('add-show-overlay').classList.contains('active');
        document.getElementById('as-city').value = 'Testville';
        document.getElementById('as-state').value = 'TN';
        document.getElementById('as-venue').value = 'Test Hall';
        document.getElementById('as-date').value = '2026-10-05';
        updateAddShowSaveEnabled();
        const disabledBeforePlacement = document.getElementById('as-save-btn').disabled;

        startShowPlacement();
        const overlayClosedDuringPlacement = !document.getElementById('add-show-overlay').classList.contains('active');
        const hintShown = document.getElementById('place-hint').style.display !== 'none';
        const cursorSet = document.getElementById('map-container').style.cursor === 'crosshair';

        const r = document.getElementById('map-container').getBoundingClientRect();
        const clickX = r.left + r.width / 2, clickY = r.top + r.height / 2;
        document.getElementById('map-container').dispatchEvent(new MouseEvent('click', { clientX: clickX, clientY: clickY, bubbles: true }));

        return {
            overlayOpenBefore, disabledBeforePlacement, overlayClosedDuringPlacement, hintShown, cursorSet,
            hintHiddenAfterClick: document.getElementById('place-hint').style.display === 'none',
            overlayReopened: document.getElementById('add-show-overlay').classList.contains('active'),
            placementStatus: document.getElementById('as-placement-status').textContent,
            saveEnabledAfterClick: !document.getElementById('as-save-btn').disabled,
            draftX: addShowDraft.x, draftY: addShowDraft.y
        };
    });
    t.ok(placement.overlayOpenBefore, 'openAddShow() opens the panel');
    t.ok(placement.disabledBeforePlacement, 'Save stays disabled until the show is placed on the map, even with every other field filled');
    t.ok(placement.overlayClosedDuringPlacement, 'starting placement closes the form so the real map underneath is clickable');
    t.ok(placement.hintShown && placement.cursorSet, 'placement mode shows the hint banner and a crosshair cursor');
    t.ok(placement.hintHiddenAfterClick && placement.overlayReopened, 'a map click ends placement mode and reopens the form');
    t.ok(placement.placementStatus.includes('Placed'), 'placement status reflects the click');
    t.ok(placement.saveEnabledAfterClick, 'Save enables once every field is filled and the show is placed');
    t.ok(placement.draftX >= 0 && placement.draftX <= 1025 && placement.draftY >= 0 && placement.draftY <= 620, `clicked point converts to in-bounds map coordinates (${placement.draftX}, ${placement.draftY})`);
    await win.evaluate(() => cancelAddShow());   // clear the draft so the next test starts clean

    // ---------------- ADD A SHOW: sorted insertion + driving-distance mileage ----------------
    step('ADD A SHOW: sorted insertion + driving-distance mileage');
    const addResult = await win.evaluate(async () => {
        // Stub the two network calls so the test is deterministic and offline-safe —
        // both are plain script functions (not contextBridge objects), so this works;
        // see the RENDER HARDENING section above for why contextBridge objects can't be.
        window.nominatimLookup = async () => [{ lat: '36.1627', lon: '-86.7816' }];
        window.drivingMiles = async () => 42;

        const before = tourData[0].id;
        const secondId = tourData[1].id;
        const midpoint = new Date((parseShowDate(tourData[0].date).getTime() + parseShowDate(tourData[1].date).getTime()) / 2);
        const isoMid = `${midpoint.getFullYear()}-${String(midpoint.getMonth() + 1).padStart(2, '0')}-${String(midpoint.getDate()).padStart(2, '0')}`;

        openAddShow();
        document.getElementById('as-city').value = 'Testville';
        document.getElementById('as-state').value = 'TN';
        document.getElementById('as-venue').value = 'Test Hall';
        document.getElementById('as-date').value = isoMid;
        document.getElementById('as-time').value = '7:00 PM';
        addShowDraft.x = 500; addShowDraft.y = 300;   // covered by the click-to-place test above
        // Fields were set via .value= (no real keystroke/change events), so the Save-enabled
        // check that click-to-place mechanics already covers must be re-run by hand here.
        updateAddShowSaveEnabled();

        await saveAddShow();
        return { predecessorId: before, successorId: secondId, isoMid };
    });

    let loadPromise = win.waitForEvent('load', { timeout: 15000 });
    await loadPromise;
    await new Promise(r => setTimeout(r, 300));
    await win.evaluate(() => { dismissOnboarding(); window.confirm = () => true; });

    const afterAdd = await win.evaluate(({ predecessorId, successorId }) => {
        const idx = tourData.findIndex(s => s.id === predecessorId);
        const added = tourData[idx + 1];
        return {
            stopCount: tourData.length,
            insertedBetween: !!added && !!tourData[idx + 2] && tourData[idx + 2].id === successorId,
            addedCustomFlag: added && added.custom === true,
            addedCity: added && added.city,
            addedMiles: added && added.milesToNext,
            predecessorMiles: tourData[idx].milesToNext,
            customShowsCount: state.customShows.length,
            overrideStored: state.mileageOverrides[predecessorId]
        };
    }, addResult);
    t.eq(afterAdd.stopCount, basics.stopCount + 1, 'the added show increases tourData length by one');
    t.ok(afterAdd.addedCustomFlag, 'the inserted stop is flagged custom: true');
    t.ok(afterAdd.insertedBetween, 'the new show is inserted in date order, directly between its two neighbors');
    t.eq(afterAdd.addedCity, 'Testville, TN', 'the new show carries the entered city and state');
    t.eq(afterAdd.addedMiles, 42, "the new show's own leg uses the stubbed driving distance");
    t.eq(afterAdd.predecessorMiles, 42, "the predecessor's stale mileage is overridden to the new (stubbed) driving distance");
    t.eq(afterAdd.customShowsCount, 1, 'the show is persisted in state.customShows');
    t.eq(afterAdd.overrideStored, 42, "the predecessor's override is persisted in state.mileageOverrides");

    // ---------------- ADD A SHOW: city-panel controls only appear on custom shows ----------------
    step('ADD A SHOW: city-panel controls only appear on custom shows');
    const customId = await win.evaluate((predecessorId) => tourData[tourData.findIndex(s => s.id === predecessorId) + 1].id, addResult.predecessorId);
    const panelToggle = await win.evaluate(async ({ customId, baselineId }) => {
        await openCityPanel(customId);
        const shownForCustom = document.getElementById('panel-custom-controls').style.display === 'flex';
        closeCityPanel();
        await openCityPanel(baselineId);
        const hiddenForBaseline = document.getElementById('panel-custom-controls').style.display === 'none';
        closeCityPanel();
        return { shownForCustom, hiddenForBaseline };
    }, { customId, baselineId: addResult.successorId });
    t.ok(panelToggle.shownForCustom, 'Edit/Remove controls appear in the city panel for a custom show');
    t.ok(panelToggle.hiddenForBaseline, 'Edit/Remove controls stay hidden for a baked-in show');

    // ---------------- EDIT A SHOW: same id keeps notes attached, fields update ----------------
    step('EDIT A SHOW: same id keeps notes attached, fields update');
    const editResult = await win.evaluate(async (id) => {
        state.cityDetails[id] = { notes: 'Pre-edit note ✓' };
        saveState();
        openEditShow(id);
        const prefilled = {
            city: document.getElementById('as-city').value,
            state: document.getElementById('as-state').value,
            venue: document.getElementById('as-venue').value,
            placed: document.getElementById('as-placement-status').textContent.includes('Placed')
        };
        document.getElementById('as-venue').value = 'Edited Hall';
        await saveAddShow();
        return { prefilled };
    }, customId);
    loadPromise = win.waitForEvent('load', { timeout: 15000 });
    await loadPromise;
    await new Promise(r => setTimeout(r, 300));
    await win.evaluate(() => { dismissOnboarding(); window.confirm = () => true; });
    t.eq(editResult.prefilled.city, 'Testville', 'openEditShow() prefills the city field from the existing stop');
    t.eq(editResult.prefilled.state, 'TN', 'openEditShow() prefills the state field');
    t.eq(editResult.prefilled.venue, 'Test Hall', 'openEditShow() prefills the venue field');
    t.ok(editResult.prefilled.placed, 'openEditShow() carries over the existing map placement');
    const afterEdit = await win.evaluate((id) => {
        const stop = tourData.find(s => s.id === id);
        return { venue: stop && stop.venue, id: stop && stop.id, notes: (state.cityDetails[id] || {}).notes, count: tourData.length };
    }, customId);
    t.eq(afterEdit.venue, 'Edited Hall', 'editing a show updates its venue');
    t.eq(afterEdit.id, customId, 'editing a show keeps the same id (so notes/photos/receipts stay attached)');
    t.eq(afterEdit.notes, 'Pre-edit note ✓', 'notes logged against a custom show survive editing it');
    t.eq(afterEdit.count, basics.stopCount + 1, 'editing does not add or drop a stop');

    // ---------------- REMOVE A SHOW: cleans up fully, reverts predecessor mileage ----------------
    step('REMOVE A SHOW: cleans up fully, reverts predecessor mileage');
    const removeResult = await win.evaluate(async ({ id, predecessorId }) => {
        await removeCustomShow(id);
        return true;
    }, { id: customId, predecessorId: addResult.predecessorId });
    loadPromise = win.waitForEvent('load', { timeout: 15000 });
    await loadPromise;
    await new Promise(r => setTimeout(r, 300));
    await win.evaluate(() => { dismissOnboarding(); window.confirm = () => true; });
    const afterRemove = await win.evaluate(({ id, predecessorId, originalMiles }) => ({
        stopCount: tourData.length,
        stillPresent: tourData.some(s => s.id === id),
        customShowsCount: state.customShows.length,
        cityDetailsGone: !(id in state.cityDetails),
        overrideGone: !(predecessorId in state.mileageOverrides),
        predecessorMilesReverted: tourData.find(s => s.id === predecessorId).milesToNext === originalMiles
    }), { id: customId, predecessorId: addResult.predecessorId, originalMiles: basics.firstMiles });
    t.eq(afterRemove.stopCount, basics.stopCount, 'removing the show brings tourData back to its original length');
    t.ok(!afterRemove.stillPresent, 'the removed show no longer appears in tourData');
    t.eq(afterRemove.customShowsCount, 0, 'the show is removed from state.customShows');
    t.ok(afterRemove.cityDetailsGone, 'notes logged against the removed show are cleaned up');
    t.ok(afterRemove.overrideGone, "the predecessor's mileage override is cleared on removal");
    t.ok(afterRemove.predecessorMilesReverted, "the predecessor's mileage reverts to its original baked-in value");

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
    loadPromise = win.waitForEvent('load', { timeout: 15000 });
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
