// Shared plumbing for the e2e scripts in this folder.
//
// Every launch() gets its own throwaway OUTLANDER_TEST_ROOT (see main.js),
// so tests never read or write the real ~/Documents/Outlander Tour Companion
// save folder that the packaged app uses day-to-day. Each temp root is
// removed after the script finishes, win or lose.
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTestRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'outlander-e2e-'));
}

// dir: project root (unpacked) or omitted when executablePath is given.
async function launch({ dir = __dirname, executablePath, testRoot, extraEnv = {} } = {}) {
    const cleanEnv = { ...process.env };
    // ELECTRON_RUN_AS_NODE would make Electron behave as plain Node instead
    // of opening a real window.
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    const root = testRoot || makeTestRoot();
    cleanEnv.OUTLANDER_TEST_ROOT = root;
    Object.assign(cleanEnv, extraEnv);

    const launchOpts = { env: cleanEnv };
    if (executablePath) launchOpts.executablePath = executablePath;
    else launchOpts.args = [dir];

    const app = await electron.launch(launchOpts);
    const win = await app.firstWindow();
    const consoleErrors = [];
    win.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    win.on('pageerror', err => consoleErrors.push('[pageerror] ' + err.message));
    await win.waitForLoadState('domcontentloaded');
    await new Promise(r => setTimeout(r, 800));

    return { app, win, testRoot: root, consoleErrors };
}

function cleanupTestRoot(root) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
}

// Tiny assertion collector — no framework dependency, just a pass/fail log
// and a process.exitCode so these scripts can gate CI instead of requiring
// someone to read the console output.
class Suite {
    constructor(name) {
        this.name = name;
        this.failures = [];
        this.passCount = 0;
    }
    ok(cond, msg) {
        if (cond) { this.passCount++; console.log('  ok - ' + msg); }
        else { this.failures.push(msg); console.log('  NOT OK - ' + msg); }
    }
    eq(actual, expected, msg) {
        const pass = JSON.stringify(actual) === JSON.stringify(expected);
        this.ok(pass, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    }
    finish() {
        console.log('');
        if (this.failures.length) {
            console.error(`FAIL: ${this.name} — ${this.failures.length} failure(s), ${this.passCount} passed`);
            process.exitCode = 1;
        } else {
            console.log(`PASS: ${this.name} — ${this.passCount} passed`);
        }
    }
}

module.exports = { launch, makeTestRoot, cleanupTestRoot, Suite };
