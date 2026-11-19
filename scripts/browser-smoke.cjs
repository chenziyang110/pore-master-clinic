/* Real Chromium layout QA. Runs in CI with Node built-ins and the runner's Chrome.
 * Gameplay fixtures skip extraction time; navigation, ice, rewards and outfit
 * buttons use the actual page. The Node suite covers detailed game rules. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'qa-output');
const TIMEOUT = 20000;
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'small-phone', width: 320, height: 568, mobile: true },
  { name: 'phone-landscape', width: 844, height: 390, mobile: true }
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class CdpPipe {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.errors = new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.fatal = null;
    this.stderr = '';
    child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-6000); });
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => this.fail(new Error(`Chrome exited (${code ?? signal})`)));
    child.stdio[3].on('error', error => this.fail(error));
    child.stdio[4].on('error', error => this.fail(error));
    child.stdio[4].on('end', () => this.fail(new Error('Chrome closed its CDP pipe')));
    child.stdio[4].on('data', data => {
      this.buffer = Buffer.concat([this.buffer, data]);
      let boundary;
      while ((boundary = this.buffer.indexOf(0)) !== -1) {
        const packet = this.buffer.subarray(0, boundary).toString('utf8');
        this.buffer = this.buffer.subarray(boundary + 1);
        if (!packet) continue;
        try { this.receive(JSON.parse(packet)); }
        catch (error) { this.fail(error); }
      }
    });
  }

  fail(error) {
    if (!this.fatal) this.fatal = error;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(this.fatal); }
    this.pending.clear();
  }

  receive(message) {
    if (message.id) {
      const task = this.pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      this.pending.delete(message.id);
      if (message.error) task.reject(new Error(`${task.method}: ${message.error.message}`));
      else task.resolve(message.result || {});
      return;
    }
    let error;
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      error = details.exception?.description || details.text;
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      error = message.params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' ');
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error'
      && message.params.entry.source === 'javascript') error = message.params.entry.text;
    if (error) {
      const list = this.errors.get(message.sessionId) || [];
      list.push(String(error));
      this.errors.set(message.sessionId, list);
    }
  }

  send(method, params = {}, sessionId) {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`${method} timed out after ${TIMEOUT}ms`)), TIMEOUT);
      this.pending.set(id, { method, resolve, reject, timer });
      const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      this.child.stdio[3].write(JSON.stringify(message) + '\0', error => { if (error) this.fail(error); });
    });
  }
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const filename = path.resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!filename.startsWith(ROOT + path.sep) || pathname.split('/').some(part => part.startsWith('.'))) {
        response.writeHead(403); response.end(); return;
      }
      const content = await fsp.readFile(filename);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    } catch (_) { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function runViewport(cdp, origin, viewport, report) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  let sessionId;
  const label = `${viewport.name}-${viewport.width}x${viewport.height}`;
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    const send = (method, params) => cdp.send(method, params, sessionId);
    const evaluate = async expression => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: TIMEOUT });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    const waitFor = async (expression, description) => {
      const started = Date.now();
      do {
        if (await evaluate(expression)) return;
        await delay(80);
      } while (Date.now() - started < TIMEOUT);
      throw new Error(`Timed out waiting for ${description}`);
    };
    const click = async selector => {
      await evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        if (!button || button.disabled || button.closest('[hidden], [inert]') || !button.getClientRects().length)
          throw new Error('Button unavailable: ' + ${JSON.stringify(selector)});
        button.scrollIntoView({block:'center',inline:'nearest'});
        button.focus({preventScroll:true}); button.click();
      })()`);
    };
    const checkpoint = async (name, expectedModal) => {
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const layout = await evaluate(`(() => {
        const modal = document.querySelector('.modal-backdrop.open');
        const active = modal || document.getElementById('app-shell');
        const containers = [document.documentElement, document.body, active,
          ...active.querySelectorAll('.modal-card,.home-grid,.wardrobe-layout,.wardrobe-items,.tool-section,.game-utilities,#viewport-wrap')];
        const overflow = [];
        for (const element of new Set(containers)) {
          const box = element.getBoundingClientRect();
          if (!box.width || !box.height || !element.clientWidth) continue;
          const name = element.id || element.className || element.tagName;
          if (element.scrollWidth > element.clientWidth + 2)
            overflow.push(name + ': scrollWidth ' + element.scrollWidth + ' > ' + element.clientWidth);
          if (box.left < -2 || box.right > innerWidth + 2)
            overflow.push(name + ': outside viewport [' + Math.round(box.left) + ', ' + Math.round(box.right) + ']');
        }
        return {width:innerWidth,height:innerHeight,modal:modal?.id || null,overflow};
      })()`);
      const filename = `${label}-${name}.png`;
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
      await fsp.writeFile(path.join(OUTPUT, filename), Buffer.from(shot.data, 'base64'));
      report.screens.push({ viewport: label, stage: name, screenshot: filename, ...layout });
      assert.equal(layout.modal, expectedModal, `${label}/${name}: expected active screen`);
      assert.equal(layout.width, viewport.width, `${label}/${name}: CSS viewport width`);
      if (layout.overflow.length) report.failures.push(`${label}/${name}: ${layout.overflow.join('; ')}`);
      console.log(`${label}/${name}: ${layout.overflow.length ? 'OVERFLOW' : 'layout OK'}`);
    };

    await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Log.enable')]);
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1,
      mobile: viewport.mobile, screenWidth: viewport.width, screenHeight: viewport.height });
    await send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.bringToFront');
    await send('Page.navigate', { url: origin });
    await waitFor('document.readyState === "complete" && typeof startAdventure === "function"', 'page startup');
    assert.equal(await evaluate('(async()=>{await careControlReady;return careControl.owned;})()'), true, 'local profile ownership');

    await checkpoint('01-home', 'home-modal');
    await click('#btn-start-adventure');
    await checkpoint('02-game-level-1', null);
    await click('#btn-wardrobe');
    await checkpoint('03-wardrobe-locked', 'wardrobe-modal');
    await click('#btn-close-wardrobe');

    for (const [level, gift, sequence] of [[3, 'bow_rose', '04'], [5, 'dress_sky', '06']]) {
      // Select a milestone and complete its extraction fixture. Rewards are
      // still revealed by updateHUD and awarded by the ordinary ice/settlement.
      await evaluate(`(() => {
        wardrobeProgress.level = ${level}; state.clientIndex = (${level}-1) % CLIENTS.length;
        generateLevel(0); state.paused=false; selectTool('steam');
        const gift = state.pimples.find(p => p.giftId === ${JSON.stringify(gift)});
        if (!gift) throw new Error('Missing milestone gift');
        gift.state=P_STATE.OOZING; gift.bloodDropSize=0; gift.serousDropSize=0;
        updateHUD(); requestSceneFrame();
      })()`);
      assert.equal(await evaluate('document.getElementById("gift-discovery").hidden'), false, 'gift discovery is visible');
      await checkpoint(`${sequence}-level-${level}-discovery`, null);
      await evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
      await click('#btn-ice-quick');
      await waitFor('state.settled && document.getElementById("result-modal").classList.contains("open")', 'milestone settlement');
      await checkpoint(`${String(Number(sequence) + 1).padStart(2, '0')}-level-${level}-reward`, 'result-modal');
      await click('#btn-open-wardrobe-result');
      await click(`[data-equip="${gift}"]`);
      assert.equal(await evaluate(`wardrobeProgress.equipped.${level === 3 ? 'hair' : 'dress'}`), gift, 'outfit button equips the earned gift');
      if (level === 5) await checkpoint('08-wardrobe-dressed', 'wardrobe-modal');
      await click('#btn-close-wardrobe');
      if (level === 3) await click('#btn-next-face');
    }
    await click('#btn-result-home');
    await checkpoint('09-home-dressed', 'home-modal');
  } finally {
    for (const error of cdp.errors.get(sessionId) || []) report.failures.push(`${label}: runtime error: ${error}`);
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

async function main() {
  await fsp.mkdir(OUTPUT, { recursive: true });
  const report = { viewports: VIEWPORTS, screens: [], failures: [] };
  let server, child, cdp, profileDirectory;
  try {
    const executable = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium'].find(file => file && fs.existsSync(file));
    assert.ok(executable, 'Install system Chrome or set CHROME_BIN');
    server = await startServer();
    profileDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pore-browser-qa-'));
    child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--mute-audio',
      '--remote-debugging-pipe', `--user-data-dir=${profileDirectory}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    cdp = new CdpPipe(child);
    report.browser = await cdp.send('Browser.getVersion');
    const origin = `http://127.0.0.1:${server.address().port}/`;
    for (const viewport of VIEWPORTS) {
      try { await runViewport(cdp, origin, viewport, report); }
      catch (error) {
        report.failures.push(`${viewport.name}: ${error.stack || error}`);
        if (cdp.fatal) break;
      }
    }
  } catch (error) { report.failures.push(error.stack || String(error)); }
  finally {
    cdp?.fail(new Error('Browser QA cleanup'));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]);
      }
    }
    if (server) {
      server.closeAllConnections();
      await Promise.race([new Promise(resolve => server.close(resolve)), delay(1500)]);
    }
    if (profileDirectory) await fsp.rm(profileDirectory, { recursive: true, force: true }).catch(() => {});
    if (cdp?.stderr && report.failures.length) await fsp.writeFile(path.join(OUTPUT, 'chrome-stderr.txt'), cdp.stderr);
    await fsp.writeFile(path.join(OUTPUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (report.failures.length) {
    console.error(report.failures.join('\n'));
    process.exitCode = 1;
  } else console.log(`Browser QA passed: ${report.screens.length} screenshots across ${VIEWPORTS.length} viewports.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
