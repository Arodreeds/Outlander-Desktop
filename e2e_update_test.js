const { _electron: electron } = require('playwright');

(async () => {
  const logs = [];
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [__dirname], env: cleanEnv });
  const win = await app.firstWindow();
  win.on('console', msg => { if (msg.type() === 'error') logs.push('[console.error] ' + msg.text()); });
  win.on('pageerror', err => logs.push('[pageerror] ' + err.message));

  await win.waitForLoadState('domcontentloaded');
  await new Promise(r => setTimeout(r, 800));
  await win.evaluate(() => dismissOnboarding());

  // Open Settings and confirm the Updates section is visible (gated on window.electronUpdater).
  const sectionVisible = await win.evaluate(async () => {
    toggleSettings();
    await new Promise(r => setTimeout(r, 200));
    return document.getElementById('update-section').style.display !== 'none';
  });
  logs.push('[update-section visible] ' + sectionVisible);

  // Click "Check for Updates" — hits the real GitHub Releases API.
  await win.evaluate(() => checkForUpdates());
  await new Promise(r => setTimeout(r, 2500)); // network round trip
  const statusText = await win.evaluate(() => document.getElementById('update-status').textContent);
  logs.push('[status after Check for Updates] ' + statusText);

  // Confirm the "View on GitHub" button is wired to the exposed API (don't actually invoke
  // it — that would pop a real browser window during an automated test).
  const openReleasePageIsFn = await win.evaluate(() => typeof window.electronUpdater.openReleasePage === 'function');
  logs.push('[openReleasePage is a function] ' + openReleasePageIsFn);

  await win.evaluate(() => toggleSettings());

  console.log(logs.join('\n'));
  console.log('---');
  console.log('console/page error count:', logs.filter(l => l.startsWith('[console.error]') || l.startsWith('[pageerror]')).length);

  await app.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
