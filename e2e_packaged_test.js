const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  const logs = [];
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;

  const appPath = path.join(__dirname, 'dist/mac/Outlander Tour Companion.app/Contents/MacOS/Outlander Tour Companion');
  const app = await electron.launch({ executablePath: appPath, env: cleanEnv });
  const win = await app.firstWindow();
  win.on('console', msg => { if (msg.type() === 'error') logs.push('[console.error] ' + msg.text()); });
  win.on('pageerror', err => logs.push('[pageerror] ' + err.message));

  await win.waitForLoadState('domcontentloaded');
  await new Promise(r => setTimeout(r, 800));

  const info = await win.evaluate(() => ({
    isElectron: window.isElectron === true,
    title: document.title,
    stopCount: tourData.length
  }));
  logs.push('[packaged app basics] ' + JSON.stringify(info));

  await win.screenshot({ path: path.join(__dirname, 'packaged_app_screenshot.png') });
  logs.push('[screenshot saved]');

  console.log(logs.join('\n'));
  await app.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
