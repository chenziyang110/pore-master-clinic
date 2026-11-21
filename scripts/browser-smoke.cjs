/* Real Chromium layout QA. Runs in CI with Node built-ins and the runner's Chrome.
 * Board stability uses real mouse input and animation frames, including held
 * heat treatment. Reward fixtures skip extraction time; navigation, ice,
 * rewards and outfit buttons use the actual page. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { roundFixtureSource } = require('../tests/round-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'qa-output');
const TIMEOUT = 20000;
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'small-phone', width: 320, height: 568, mobile: true },
  { name: 'phone-landscape', width: 844, height: 390, mobile: true },
  { name: 'tablet', width: 820, height: 1180, mobile: false, geometryOnly: true }
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

async function checkBoardStability({ send, evaluate, viewport, label, report }) {
  const result = { viewport: label, motion: 'no-preference', status: 'running', hoverCycles: 0, checks: [] };
  report.geometry.push(result);
  const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const mouse = (type, point, held = false) => send('Input.dispatchMouseEvent', {
    type, x: point.x, y: point.y, pointerType: 'mouse',
    button: type === 'mouseMoved' ? 'none' : 'left', buttons: held ? 1 : 0,
    ...(type === 'mouseMoved' ? {} : { clickCount: 1 })
  });
  const realClick = async selector => {
    const point = await evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button || button.disabled || button.closest('[hidden], [inert]')
        || !button.getClientRects().length || getComputedStyle(button).visibility !== 'visible')
        throw new Error('Mouse button unavailable: ' + ${JSON.stringify(selector)});
      button.scrollIntoView({block:'center',inline:'nearest'});
      const box = button.getBoundingClientRect();
      const point = {x:(box.left+box.right)/2,y:(box.top+box.bottom)/2};
      if (!button.contains(document.elementFromPoint(point.x,point.y)))
        throw new Error('Mouse button covered: ' + ${JSON.stringify(selector)});
      return point;
    })()`);
    await mouse('mouseMoved', point);
    await mouse('mousePressed', point, true);
    await mouse('mouseReleased', point);
  };
  const phase = name => evaluate(`window.__boardLayoutQA.phase = ${JSON.stringify(name)}`);
  let baseline;
  const stable = async name => {
    await frames();
    const observation = await evaluate(`(() => {
      const qa = window.__boardLayoutQA, next = document.getElementById('btn-care-next');
      return {geometry:qa.snapshot(),firstChange:qa.firstChange,resizeCalls:qa.resizeCalls,
        layoutCalls:qa.layoutCalls,nextHidden:next.hidden,nextTool:next.dataset.tool,
        nextVisible:!next.closest('[hidden], [inert]') && !!next.getClientRects().length
          && getComputedStyle(next).visibility === 'visible',
        selected:currentPointerCareTarget()?.item.id ?? null,
        active:state.pointer.active,mode:state.pointer.mode,
        heat:state.pimples.find(p => p.id === qa.targetId)?.steamed};
    })()`);
    assert.deepEqual(observation.geometry, baseline, `${label}/${name}: board and targets must stay fixed`);
    assert.equal(observation.firstChange, null,
      `${label}/${name}: transient board movement: ${JSON.stringify(observation.firstChange)}`);
    assert.equal(observation.resizeCalls, 0, `${label}/${name}: UI changes must not resize the canvas`);
    assert.equal(observation.layoutCalls, 0, `${label}/${name}: UI changes must not rearrange targets`);
    result.checks.push(name);
    return observation;
  };
  try {
    assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), false,
      `${label}: test normal motion, not reduced-motion shortcuts`);
    await frames();
    baseline = await evaluate(`(() => {
      const rect = element => {
        const box = element.getBoundingClientRect();
        return {left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:box.width,height:box.height};
      };
      const qa = window.__boardLayoutQA = {phase:'initial',resizeCalls:0,layoutCalls:0,
        frames:0,firstChange:null,originalResize:resizeCanvas,originalLayout:layoutTreatmentScene};
      qa.snapshot = () => ({viewport:rect(viewportWrap),canvas:rect(canvas),
        buffer:{width:canvas.width,height:canvas.height},
        logical:{width:state.width,height:state.height,dpr:state.dpr},runId:state.runId,
        targets:state.pimples.map(p => ({id:p.id,x:p.x,y:p.y,radius:p.radius}))});
      qa.baseline = qa.snapshot();
      const expected = JSON.stringify(qa.baseline);
      resizeCanvas = function(...args) { qa.resizeCalls++; return qa.originalResize.apply(this,args); };
      layoutTreatmentScene = function(...args) { qa.layoutCalls++; return qa.originalLayout.apply(this,args); };
      const observe = () => {
        qa.frames++;
        const current = qa.snapshot();
        if (!qa.firstChange && JSON.stringify(current) !== expected) qa.firstChange = {phase:qa.phase,geometry:current};
        qa.raf = requestAnimationFrame(observe);
      };
      qa.raf = requestAnimationFrame(observe);
      return qa.baseline;
    })()`);
    result.baseline = baseline;
    assert.ok(baseline.viewport.width > 0 && baseline.viewport.height > 0 && baseline.targets.length > 0,
      `${label}: a real board is present`);
    assert.equal(await evaluate('state.practiceGuide?.active'), true, `${label}: new-game teaching is active`);

    const skipTeaching = async name => {
      await phase(name);
      const available = await evaluate(`(() => {
        const button = document.getElementById('btn-skip-practice');
        return !button.closest('[hidden], [inert]') && !!button.getClientRects().length
          && getComputedStyle(button).visibility === 'visible';
      })()`);
      if (available) await realClick('#btn-skip-practice');
      else {
        // The short landscape UI intentionally omits teaching controls. Its
        // logical teaching state must still be harmless to the board geometry.
        assert.equal(viewport.name, 'phone-landscape', `${label}: teaching skip is usable`);
        await evaluate('finishPracticeGuide(true); updateCareGuidance();');
      }
      assert.equal(await evaluate('state.practiceGuide.active'), false, `${label}: teaching was skipped`);
      await stable(name);
    };
    await skipTeaching('teaching-hidden');
    await phase('teaching-replayed');
    await realClick('#btn-help');
    await realClick('#btn-replay-practice');
    assert.equal(await evaluate('state.practiceGuide.active'), true, `${label}: help reopens teaching`);
    await stable('teaching-replayed');
    await skipTeaching('teaching-hidden-again');
    await realClick('#tool-steam');
    await stable('steam-selected');

    const points = await evaluate(`(() => {
      const qa = window.__boardLayoutQA;
      const p = state.pimples.find(item => item.type === 'blackhead' && item.steamed === 0);
      if (!p) throw new Error('A cold blackhead is needed for real hover and heat input');
      qa.targetId = p.id;
      const bounds = canvas.getBoundingClientRect();
      const screen = point => ({x:bounds.left+point.x/state.width*bounds.width,
        y:bounds.top+point.y/state.height*bounds.height});
      let empty = null, clearance = -Infinity;
      for (let y=16;y<state.height-16;y+=16) for (let x=16;x<state.width-16;x+=16) {
        const point = screen({x,y});
        if (document.elementFromPoint(point.x,point.y) !== canvas) continue;
        const gap = Math.min(...state.pimples.map(item => Math.hypot(x-item.x,y-item.y)
          - Math.max(25,(item.hitRadius || item.radius)*1.6)));
        if (gap > clearance) { clearance=gap; empty=point; }
      }
      if (!empty || clearance < 8) throw new Error('No empty skin point for hover regression');
      const target = screen(p);
      if (document.elementFromPoint(target.x,target.y) !== canvas) throw new Error('Heat target is covered');
      return {target,empty,id:p.id};
    })()`);
    // This is the user's repro: selecting a cold target with steam already
    // equipped hides the suggestion; moving back to empty skin shows it again.
    for (let i = 0; i < 20; i++) {
      await phase(`hover-target-${i + 1}`);
      await mouse('mouseMoved', points.target);
      const selected = await stable(`hover-target-${i + 1}`);
      assert.equal(selected.selected, points.id, `${label}: real mouse selects the target`);
      assert.equal(selected.nextHidden, true, `${label}: the matching-tool suggestion hides`);
      assert.equal(selected.nextVisible, false, `${label}: hidden suggestion is not displayed`);
      await phase(`hover-empty-${i + 1}`);
      await mouse('mouseMoved', points.empty);
      const empty = await stable(`hover-empty-${i + 1}`);
      assert.equal(empty.selected, null, `${label}: real mouse clears the target on empty skin`);
      assert.equal(empty.nextHidden, false, `${label}: the next-target suggestion reappears`);
      if (viewport.name !== 'phone-landscape')
        assert.equal(empty.nextVisible, true, `${label}: next-target suggestion is displayed`);
      result.hoverCycles++;
    }

    // Exercise wrapping through the production hint renderer. Combining the
    // existing guidance copy makes this cover multiple lines even on desktop;
    // no dimensions, CSS rules or target positions are changed by the fixture.
    for (const [name, expression] of [
      ['short-hint', "setHint('慢慢来。', 'normal')"],
      ['wrapped-hint', "setHint(Object.values(TOOL_GUIDANCE).join(' '), 'warn')"],
      ['short-hint-again', "setHint('慢慢来。', 'good')"]
    ]) {
      await phase(name);
      await evaluate(expression);
      await stable(name);
      if (name === 'wrapped-hint') {
        result.hintLines = await evaluate(`(() => {
          const range = document.createRange(); range.selectNodeContents(document.getElementById('hint-banner'));
          return new Set(Array.from(range.getClientRects(), box => box.top)).size;
        })()`);
        assert.ok(result.hintLines > 1, `${label}: long hint really wraps in the browser`);
      }
    }

    await phase('held-steam');
    await realClick('#tool-steam');
    await mouse('mouseMoved', points.target);
    const cold = await stable('before-held-steam');
    assert.equal(cold.heat, 0, `${label}: real heat input starts cold`);
    assert.equal(cold.nextHidden, true, `${label}: recommendation starts hidden before warming`);
    let warmed = cold, crossedThreshold = false;
    const started = Date.now();
    try {
      await mouse('mousePressed', points.target, true);
      while (Date.now() - started < TIMEOUT) {
        const sample = await stable('held-steam-frame');
        assert.equal(sample.active, true, `${label}: hold must survive guidance and HUD updates`);
        assert.equal(sample.mode, 'steam', `${label}: heat input remains active`);
        assert.ok(sample.heat >= warmed.heat, `${label}: heat keeps increasing while held`);
        if (warmed.heat < 0.75 && sample.heat >= 0.75) crossedThreshold = true;
        warmed = sample;
        if (sample.heat >= 0.95) break;
        await delay(40);
      }
      assert.ok(crossedThreshold && warmed.heat >= 0.95, `${label}: held heat crosses the recommendation threshold and continues`);
      assert.equal(warmed.nextHidden, false, `${label}: warmed target shows its next tool during the hold`);
      assert.equal(warmed.nextTool, 'tweezers', `${label}: actual warmed-blackhead guidance changed`);
      result.heat = {before:cold.heat,after:warmed.heat,crossedThreshold,held:true};
    } finally {
      await mouse('mouseReleased', points.target);
    }
    const released = await stable('released-steam');
    assert.equal(released.active, false, `${label}: explicit mouseup ends the hold`);
    result.status = 'passed';
    console.log(`${label}: stable board through 20 hover cycles, teaching, wrapped hints and held heat`);
  } finally {
    const observation = await evaluate(`(() => {
      const qa = window.__boardLayoutQA;
      if (!qa) return null;
      cancelAnimationFrame(qa.raf);
      resizeCanvas = qa.originalResize; layoutTreatmentScene = qa.originalLayout;
      const observation = {frames:qa.frames,resizeCalls:qa.resizeCalls,layoutCalls:qa.layoutCalls,
        firstChange:qa.firstChange,final:qa.snapshot()};
      delete window.__boardLayoutQA;
      return observation;
    })()`).catch(() => null);
    if (result.status !== 'passed') result.status = 'failed';
    if (observation) Object.assign(result, observation);
  }
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
    const trustedClick = async selector => {
      const point = await evaluate(`(() => {
        const button=document.querySelector(${JSON.stringify(selector)});
        if(!button||button.disabled||button.closest('[hidden], [inert]')||!button.getClientRects().length
          ||getComputedStyle(button).visibility!=='visible')throw new Error('User control is unavailable');
        button.scrollIntoView({block:'center',inline:'nearest'});
        const box=button.getBoundingClientRect(),point={x:(box.left+box.right)/2,y:(box.top+box.bottom)/2};
        if(!button.contains(document.elementFromPoint(point.x,point.y)))throw new Error('User control is covered');
        return point;
      })()`);
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point,pointerType:'mouse',button:'none',buttons:0});
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,pointerType:'mouse',button:'left',buttons:1,clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,pointerType:'mouse',button:'left',buttons:0,clickCount:1});
    };
    const checkpoint = async (name, expectedModal) => {
      await evaluate('Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      // Check before click() scrolls anything into view: the main entry and
      // everyday care controls must be immediately usable at each screen size.
      const requiredControls = expectedModal === 'home-modal' ? ['#btn-start-adventure']
        : expectedModal === null ? ['#btn-wardrobe', '#tool-steam', '#tool-needle', '#tool-squeeze', '#tool-tweezers', '#tool-swab'] : [];
      const layout = await evaluate(`(() => {
        const modal = document.querySelector('.modal-backdrop.open');
        const active = modal || document.getElementById('app-shell');
        const containers = [document.documentElement, document.body, active,
          ...active.querySelectorAll('.modal-card,.home-grid,.wardrobe-layout,.wardrobe-items,#wardrobe-preview,#wardrobe-food-collection,.tool-section,.game-utilities,#viewport-wrap')];
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
        const visibilityIssues = [];
        const controls = ${JSON.stringify(requiredControls)}.map(selector => {
          const button = document.querySelector(selector);
          if (!button || !button.getClientRects().length || button.disabled || button.closest('[hidden], [inert]')) {
            visibilityIssues.push(selector + ': missing, hidden or disabled');
            return {selector,visible:false};
          }
          const box = button.getBoundingClientRect();
          let left=0, top=0, right=innerWidth, bottom=innerHeight;
          for (let ancestor=button.parentElement; ancestor; ancestor=ancestor.parentElement) {
            const style=getComputedStyle(ancestor), bounds=ancestor.getBoundingClientRect();
            if (style.visibility === 'hidden' || Number(style.opacity) === 0) {
              visibilityIssues.push(selector + ': invisible ancestor');
            }
            if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) {
              left=Math.max(left,bounds.left+ancestor.clientLeft);
              right=Math.min(right,bounds.left+ancestor.clientLeft+ancestor.clientWidth);
            }
            if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) {
              top=Math.max(top,bounds.top+ancestor.clientTop);
              bottom=Math.min(bottom,bounds.top+ancestor.clientTop+ancestor.clientHeight);
            }
          }
          const fullyVisible = box.width>0 && box.height>0 && box.left>=left-1 && box.right<=right+1
            && box.top>=top-1 && box.bottom<=bottom+1;
          if (!fullyVisible) visibilityIssues.push(selector + ': clipped or outside the initial viewport');
          else {
            const hit=document.elementFromPoint((box.left+box.right)/2,(box.top+box.bottom)/2);
            if (!hit || !button.contains(hit)) visibilityIssues.push(selector + ': covered by another element');
          }
          return {selector,visible:fullyVisible,rect:{x:Math.round(box.x),y:Math.round(box.y),
            width:Math.round(box.width),height:Math.round(box.height)}};
        });
        return {width:innerWidth,height:innerHeight,modal:modal?.id || null,overflow,controls,visibilityIssues};
      })()`);
      const filename = `${label}-${name}.png`;
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
      await fsp.writeFile(path.join(OUTPUT, filename), Buffer.from(shot.data, 'base64'));
      report.screens.push({ viewport: label, stage: name, screenshot: filename, ...layout });
      assert.equal(layout.modal, expectedModal, `${label}/${name}: expected active screen`);
      assert.equal(layout.width, viewport.width, `${label}/${name}: CSS viewport width`);
      if (layout.overflow.length) report.failures.push(`${label}/${name}: ${layout.overflow.join('; ')}`);
      if (layout.visibilityIssues.length) report.failures.push(`${label}/${name}: ${layout.visibilityIssues.join('; ')}`);
      console.log(`${label}/${name}: ${layout.overflow.length || layout.visibilityIssues.length ? 'LAYOUT FAILURE' : 'layout OK'}`);
    };

    await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Log.enable'), send('DOM.enable')]);
    await send('CSS.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1,
      mobile: viewport.mobile, screenWidth: viewport.width, screenHeight: viewport.height });
    await send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Page.bringToFront');
    await send('Page.navigate', { url: origin });
    await waitFor('document.readyState === "complete" && typeof startAdventure === "function"', 'page startup');
    assert.equal(await evaluate('(async()=>{await careControlReady;return careControl.owned;})()'), true, 'local profile ownership');
    await evaluate('document.fonts.ready.then(()=>true)');
    const {root} = await send('DOM.getDocument', {depth:1});
    for (const selector of ['#home-title', '#btn-start-adventure']) {
      const {nodeId} = await send('DOM.querySelector', {nodeId:root.nodeId, selector});
      const {fonts} = await send('CSS.getPlatformFontsForNode', {nodeId});
      report.fonts.push({viewport:label,selector,fonts});
      if (!fonts.some(font => /Noto.*CJK/.test(font.familyName) && font.glyphCount>0))
        report.failures.push(`${label}/${selector}: Chinese Noto CJK glyphs were not rendered`);
    }

    if (!viewport.geometryOnly) await checkpoint('01-home', 'home-modal');
    await click('#btn-start-adventure');
    if (!viewport.geometryOnly) await checkpoint('02-game-level-1', null);
    await checkBoardStability({ send, evaluate, viewport, label, report });
    if (viewport.geometryOnly) return;
    if (viewport.name === 'desktop') {
      // One real-browser audio gate: trusted mouse clicks must respect mute
      // and may start the ordinary UI sound scope while the wardrobe is open.
      const initialMuted=await evaluate('sound.muted');
      if(!initialMuted)await trustedClick('#btn-sound');
      await trustedClick('#btn-wardrobe');
      const muted=await evaluate(`({muted:sound.muted,uiVoices:[...sound.voices].filter(voice=>voice.scope==='ui').length,
        pressed:document.getElementById('btn-sound').getAttribute('aria-pressed'),
        wardrobeOpen:document.getElementById('wardrobe-modal').classList.contains('open')})`);
      assert.deepEqual(muted,{muted:true,uiVoices:0,pressed:'false',wardrobeOpen:true},'trusted wardrobe click stays silent when muted');
      await trustedClick('#btn-close-wardrobe');
      await trustedClick('#btn-sound');
      await waitFor('[...sound.voices].every(voice=>voice.scope!=="ui")&&!sound.resumePending','sound toggle feedback to finish');
      await trustedClick('#btn-wardrobe');
      const enabled=await evaluate(`(async()=>{
        if(sound.resumePending)await sound.resumePending;
        return {muted:sound.muted,context:sound.ctx?.state,uiVoices:[...sound.voices].filter(voice=>voice.scope==='ui').length,
          pressed:document.getElementById('btn-sound').getAttribute('aria-pressed'),
          wardrobeOpen:document.getElementById('wardrobe-modal').classList.contains('open')};
      })()`);
      assert.equal(enabled.muted,false);
      assert.equal(enabled.context,'running','a trusted activation resumes the real AudioContext');
      assert.ok(enabled.uiVoices>0,'the actual wardrobe button starts UI sound voices');
      assert.equal(enabled.pressed,'true');assert.equal(enabled.wardrobeOpen,true);
      report.audio.push({viewport:label,initialMuted,muted,enabled});
      await trustedClick('#btn-close-wardrobe');
      if(initialMuted)await trustedClick('#btn-sound');
    }
    await click('#btn-wardrobe');
    await click('#wardrobe-tab-outfits');
    const previewNames={mask_pearl:'美白面膜',dress_sky:'蓝色公主裙',crown_snow:'白雪公主的王冠',shoes_crystal:'水晶鞋'};
    const unknownWardrobe = await evaluate(`(() => {
      const collection=document.getElementById('wardrobe-collection');
      const modal=document.getElementById('wardrobe-modal');
      const names=${JSON.stringify(previewNames)};
      const expected={hair:'none',dress:'patched',skin:'natural',lashes:'natural',eyes:'natural',lips:'natural',
        hairstyle:'original',shoes:'worn',bracelet:'none',necklace:'none'};
      return {buttons:collection.querySelectorAll('button[data-equip]').length,art:collection.querySelectorAll('svg').length,
        previews:[...document.querySelectorAll('#wardrobe-preview [data-preview]')].map(card=>({id:card.dataset.preview,
          name:card.textContent.includes(names[card.dataset.preview]||WARDROBE_ITEMS.find(item=>item.id===card.dataset.preview)?.name),
          art:!!card.querySelector('svg'),locked:card.textContent.includes('暂未获得')})),
        expectedIds:WARDROBE_ITEMS.map(item=>item.id),
        dreams:[...document.querySelectorAll('#dream-preview [data-dream-preview]')].map(card=>({id:card.dataset.dreamPreview,
          locked:card.textContent.includes('暂未获得'),art:!!card.querySelector('svg')})),
        foods:[...document.querySelectorAll('#wardrobe-food-collection [data-food-preview]')].map(card=>({id:card.dataset.foodPreview,
          locked:card.textContent.includes('暂未获得'),art:!!card.querySelector('svg')})),
        feedingButtons:document.querySelectorAll('#wardrobe-food-collection [data-feed]').length,
        dreamButtons:document.querySelectorAll('[data-dream-equip]').length,
        previewEquip:!!modal.querySelector('#wardrobe-preview [data-equip]'),
        freshSlots:Object.entries(expected).every(([slot,id])=>wardrobeProgress.equipped[slot]===id
          &&['home-girl','wardrobe-girl'].every(portrait=>{
            const layers=[...document.querySelectorAll('#'+portrait+' [data-dressup-slot="'+slot+'"]')];
            return layers.length&&layers.every(layer=>layer.dataset.equipped===id);
          })),
        dreamDecorations:document.querySelectorAll('#home-dream-scene [data-dream-slot],#wardrobe-dream-scene [data-dream-slot]').length};
    })()`);
    assert.equal(unknownWardrobe.previews.length,20);
    assert.deepEqual(unknownWardrobe.previews.map(card=>card.id).sort(),unknownWardrobe.expectedIds.sort(),
      `${label}: all twenty unowned outfits are previewed`);
    assert.deepEqual(unknownWardrobe.previews.slice(0,4).map(card=>card.id),Object.keys(previewNames),
      `${label}: the four requested treasures appear first`);
    assert.ok(unknownWardrobe.previews.every(card=>card.name&&card.art&&card.locked),`${label}: every outfit has named artwork and a not-yet-owned label`);
    assert.equal(unknownWardrobe.dreams.length,8);assert.equal(unknownWardrobe.foods.length,8);
    assert.ok([...unknownWardrobe.dreams,...unknownWardrobe.foods].every(card=>card.locked&&card.art),
      `${label}: all dreams and foods show their locked previews`);
    assert.equal(unknownWardrobe.feedingButtons,0);assert.equal(unknownWardrobe.dreamButtons,0);
    assert.equal(unknownWardrobe.previewEquip,false,`${label}: preview cards cannot equip unowned items`);
    assert.equal(unknownWardrobe.buttons,0);assert.equal(unknownWardrobe.art,0);
    assert.equal(unknownWardrobe.freshSlots,true,`${label}: the fresh girl wears only default clothes and accessories`);
    assert.equal(unknownWardrobe.dreamDecorations,0,`${label}: previewed dreams are not already beside the girl`);
    await checkpoint('03-wardrobe-surprises', 'wardrobe-modal');
    await click('#btn-close-wardrobe');

    const foodGift=await evaluate('FOOD_ITEMS[0].id');
    for (const [level, gift, slot, sequence] of [[4, foodGift, 'food', '04'], [7, 'dress_sky', 'dress', '06']]) {
      // Bind a known random outcome to an actual care point for stable QA.
      // Reveal, flight animation and the ice/settlement award are production paths.
      await evaluate(roundFixtureSource({level}));
      const flight = await evaluate(`(() => {
        state.discoveredGifts=[];
        state.pimples.forEach(p=>{p.giftId=null;});
        const source=state.pimples[0];source.giftId=${JSON.stringify(gift)};
        state.initialPimples.forEach(p=>{p.giftId=state.pimples.find(item=>item.id===p.id).giftId;});
        if(source.sharedPore){source.sharedPore.phase='done';if(source.sharedPore.mode==='sequential'){source.type='whitehead';source.cfg=CONFIG.TYPES.WHITEHEAD;}}
        source.state=P_STATE.OOZING;source.bloodDropSize=0;source.serousDropSize=0;
        updateHUD(); requestSceneFrame();
        const node=document.querySelector('#gift-flight-layer .gift-flight[data-item-id="'+source.giftId+'"]');
        if(!node)throw new Error('Revealed gift did not fly from its care point');
        const animation=node.getAnimations()[0];
        if(!animation)throw new Error('Normal-motion gift needs its reveal animation');
        const bounds=canvas.getBoundingClientRect();
        const sample=()=>{const box=node.getBoundingClientRect();return {x:(box.left+box.right)/2,y:(box.top+box.bottom)/2,width:box.width,height:box.height};};
        animation.pause();animation.currentTime=0;const start=sample();
        animation.currentTime=Number(animation.effect.getTiming().duration)*.95;const grown=sample();
        animation.currentTime=0;animation.play();
        return {itemId:node.dataset.itemId,sourceId:node.dataset.sourcePimpleId,
          x:Number(node.dataset.sourceX),y:Number(node.dataset.sourceY),expectedId:String(source.id),
          expectedX:source.x/state.width,expectedY:source.y/state.height,
          expectedCenter:{x:bounds.left+source.x/state.width*bounds.width,y:bounds.top+source.y/state.height*bounds.height},
          start,grown,owned:wardrobeProgress.unlocked.includes(source.giftId)||(wardrobeProgress.pantry[source.giftId]||0)>0};
      })()`);
      assert.equal(flight.itemId,gift);
      assert.equal(flight.sourceId,flight.expectedId,`${label}: the flight names its real care point`);
      assert.ok(Math.abs(flight.x-flight.expectedX)<1e-6&&Math.abs(flight.y-flight.expectedY)<1e-6,
        `${label}: flight coordinates come from the revealed care point`);
      assert.ok(Math.hypot(flight.start.x-flight.expectedCenter.x,flight.start.y-flight.expectedCenter.y)<2,
        `${label}: the tiny gift starts inside its source opening`);
      assert.ok(flight.grown.width>flight.start.width*4&&flight.grown.y<flight.start.y,
        `${label}: the gift grows and flies upward`);
      assert.equal(flight.owned,false,`${label}: animation alone does not grant ownership`);
      report.giftFlights.push({viewport:label,level,...flight});
      await waitFor('!document.getElementById("gift-discovery").hidden','gift announcement after its flight begins');
      await checkpoint(`${sequence}-level-${level}-discovery`, null);
      await evaluate(`state.pimples.forEach(p=>{
        if(p.sharedPore){p.sharedPore.phase='done';if(p.sharedPore.mode==='sequential'){p.type='whitehead';p.cfg=CONFIG.TYPES.WHITEHEAD;}}
        p.state=P_STATE.HEALED;p.healProgress=1;
      });updateHUD();`);
      await click('#btn-ice-quick');
      await waitFor('state.settled && document.getElementById("result-modal").classList.contains("open")', 'gift settlement');
      if(slot!=='food')await checkpoint(`${String(Number(sequence) + 1).padStart(2, '0')}-level-${level}-reward`, 'result-modal');
      await click('#btn-open-wardrobe-result');
      if(slot==='food') {
        await trustedClick('#wardrobe-tab-food');
        const before=await evaluate(`({quantity:wardrobeProgress.pantry[${JSON.stringify(gift)}],hunger:wardrobeProgress.hunger,
          satiety:FOOD_ITEMS.find(item=>item.id===${JSON.stringify(gift)}).satiety})`);
        assert.equal(before.quantity,1,`${label}: completed care grants one consumable serving`);
        assert.ok(before.hunger>0,`${label}: the girl is hungry after care`);
        await trustedClick(`#wardrobe-food-collection [data-feed="${gift}"]`);
        const after=await evaluate(`({quantity:wardrobeProgress.pantry[${JSON.stringify(gift)}]||0,hunger:wardrobeProgress.hunger,
          message:document.getElementById('wardrobe-status').textContent,
          shownHunger:document.getElementById('wardrobe-hunger').textContent,
          feedButton:!!document.querySelector('#wardrobe-food-collection [data-feed="${gift}"]'),
          lockedPreview:document.querySelector('#wardrobe-food-collection [data-food-preview="${gift}"]')?.textContent.includes('暂未获得')||false,
          outfits:wardrobeProgress.unlocked.slice()})`);
        assert.equal(after.quantity,before.quantity-1,`${label}: one real feed click consumes one serving`);
        assert.equal(after.feedButton,false);assert.equal(after.lockedPreview,true,`${label}: consuming the last serving returns the food to its locked preview`);
        assert.equal(after.hunger,Math.max(0,before.hunger-before.satiety),`${label}: food reduces actual hunger`);
        assert.match(after.message,/谢谢你的款待/);
        assert.ok(after.shownHunger.includes(String(after.hunger)),`${label}: the hunger display follows the meal`);
        assert.deepEqual(after.outfits,[],`${label}: food never becomes a permanent outfit`);
        await evaluate('document.querySelector("#wardrobe-modal .modal-card").scrollTop=0;document.getElementById("btn-close-wardrobe").focus({preventScroll:true});');
        const caption=await evaluate(`(() => {
          // The fixed status below the mirror is the meal response on every
          // viewport; the secondary portrait caption is hidden on short screens.
          const node=document.getElementById('wardrobe-status');
          if(!node)throw new Error('The girl needs a visible meal response');
          const visible=()=>{
            const box=node.getBoundingClientRect();let left=0,top=0,right=innerWidth,bottom=innerHeight;
            for(let parent=node;parent;parent=parent.parentElement){
              const style=getComputedStyle(parent),bounds=parent.getBoundingClientRect();
              if(style.visibility!=='visible'||Number(style.opacity)===0||parent.hidden)return false;
              if(/hidden|clip|scroll|auto/.test(style.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}
              if(/hidden|clip|scroll|auto/.test(style.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
            }
            return box.width>0&&box.height>0&&box.left>=left&&box.right<=right&&box.top>=top&&box.bottom<=bottom
              &&node.contains(document.elementFromPoint((box.left+box.right)/2,(box.top+box.bottom)/2));
          };
          const scrolledIntoView=!visible();
          if(scrolledIntoView)node.scrollIntoView({block:'center',inline:'nearest'});
          return {text:node.textContent,visible:visible(),scrolledIntoView};
        })()`);
        assert.match(caption.text,/谢谢你的款待/);
        assert.equal(caption.visible,true,`${label}: the fixed meal feedback is visible and unobscured in the meal screenshot`);
        if(viewport.name!=='phone-landscape')assert.equal(caption.scrolledIntoView,false,
          `${label}: ordinary portrait and desktop layouts show the thanks immediately`);
        report.feeding.push({viewport:label,itemId:gift,before,after,caption});
        await checkpoint('05-food-thank-you','wardrobe-modal');
      } else {
        await click('#wardrobe-tab-outfits');
        await click(`[data-equip="${gift}"]`);
        await evaluate('wardrobeVisualReady.then(()=>true)');
        assert.equal(await evaluate(`wardrobeProgress.equipped.${slot}`), gift, 'outfit button equips the earned gift');
        assert.equal(await evaluate(`!!document.querySelector('#wardrobe-preview [data-preview="${gift}"]')`),false,
          `${label}: an earned treasure leaves the unowned preview`);
      }
      assert.equal(await evaluate(`(() => {
        const owned=wardrobeProgress.unlocked.slice().sort();
        const shown=[...document.querySelectorAll('#wardrobe-collection button[data-equip]')].map(button=>button.dataset.equip).sort();
        return JSON.stringify(owned)===JSON.stringify(shown);
      })()`),true,'the collection lists only items actually earned');
      if (slot === 'dress') await checkpoint('08-wardrobe-dressed', 'wardrobe-modal');
      await click('#btn-close-wardrobe');
      if (slot === 'food') await click('#btn-next-face');
    }
    await click('#btn-result-home');
    await checkpoint('09-home-dressed', 'home-modal');
    await click('#btn-home-wardrobe');
    await click('#wardrobe-tab-outfits');
    // A separate ownership fixture shows all ten visible outfit layers. The
    // two reward scenarios above already verified that care grants ownership.
    await evaluate('wardrobeProgress.unlocked=WARDROBE_ITEMS.map(item=>item.id);wardrobeProgress.dreams=DREAM_ITEMS.map(item=>item.id);renderWardrobe();saveCurrentSession(true);');
    // Clicking an equipped item now removes it. Start this independent full
    // outfit fixture from the real reset action, then await the loaded artwork.
    await evaluate('equipWardrobeItem("reset:all");wardrobeVisualReady.then(()=>true)');
    const fullOutfit={hair:'crown_snow',dress:'dress_sky',skin:'mask_pearl',lashes:'mascara_cocoa',eyes:'contacts_ocean',
      lips:'lipstick_rose',hairstyle:'hairstyle_twintails',shoes:'shoes_crystal',bracelet:'bracelet_pearl',necklace:'necklace_star'};
    for(const [slot,id] of Object.entries(fullOutfit)) {
      await click(`#wardrobe-collection [data-equip="${id}"]`);
      await evaluate('wardrobeVisualReady.then(()=>true)');
      assert.equal(await evaluate(`wardrobeProgress.equipped.${slot}`),id,`${label}: ${slot} is independently equipped`);
    }
    const outfitLayers=await evaluate(`(() => {
      const expected=${JSON.stringify(fullOutfit)};
      return Object.entries(expected).filter(([slot,id])=>{
        const layers=[...document.querySelectorAll('#wardrobe-girl [data-dressup-slot="'+slot+'"]')];
        return !layers.length||layers.some(layer=>layer.dataset.equipped!==id);
      }).map(([slot])=>slot);
    })()`);
    assert.deepEqual(outfitLayers,[],`${label}: the portrait displays all equipped layers`);
    const dreamScene={pet:'pet_kitten',room:'room_vanity',ride:'ride_carriage',bag:'bag_starlight',toy:'toy_bunny'};
    for(const [slot,id] of Object.entries(dreamScene)) {
      await click(`[data-dream-equip="${id}"]`);
      assert.equal(await evaluate(`wardrobeProgress.dreamEquipped.${slot}`),id,`${label}: ${slot} dream is independently selected`);
    }
    assert.deepEqual(await evaluate(`(() => {
      const expected=${JSON.stringify(dreamScene)};
      return Object.entries(expected).filter(([slot,id])=>{
        const layer=document.querySelector('#wardrobe-dream-scene [data-dream-slot="'+slot+'"]');
        return !layer||layer.dataset.equipped!==id;
      }).map(([slot])=>slot);
    })()`),[],`${label}: the dream scene displays the chosen companions and objects`);
    await evaluate('document.querySelector("#wardrobe-modal .modal-card").scrollTop=0;document.getElementById("btn-close-wardrobe").focus({preventScroll:true});');
    await checkpoint('10-full-outfit', 'wardrobe-modal');
    await click('#btn-close-wardrobe');
    await click('#btn-start-adventure');
    // Visual-only fixture: show paired contents, a remaining whitehead, a
    // giant uneven bundle and a large whitehead's cleared pit together.
    // Mechanics and resume use separate real-input tests.
    await evaluate(roundFixtureSource({level:6}));
    const shared = await evaluate(`(() => {
      selectTool('squeeze');
      finishPracticeGuide(true);clearGiftPresentation();
      const blackheads=state.pimples.filter(p=>p.type==='blackhead').slice(0,3);
      const largeWhitehead=state.pimples.find(p=>p.type==='whitehead');
      const [together,sequential,bundle]=blackheads;
      if(!bundle||!largeWhitehead)throw new Error('The contents screenshot requires three blackheads and one whitehead');
      state.pimples=[...blackheads,largeWhitehead];
      blackheads.forEach((p,index)=>{
        p.linkedPore=false;p.giftId=null;p.steamed=1;p.pierced=true;p.blackheadCount=index===2?4:1;
        p.blackheadLengths=index===2?[.6,1,1.5,.8]:[1];p.blackheadSize=index===2?'giant':'normal';p.whiteheadSize='normal';
        p.sharedPore=index===2?null:{mode:index?'sequential':'together',phase:'blackhead'};
        p.state=P_STATE.EXTRUDING;p.extrudeProgress=.62;p.wormTotalLen=74;
        p.x=state.width*[.25,.75,.32][index];p.y=state.height*[.36,.36,.72][index];
        p.nx=p.x/state.width;p.ny=p.y/state.height;
        p.pressure=.42;p.swellVisual=.42;p.bloodDropSize=0;
      });
      advanceSharedPore(sequential);
      sequential.pusRemaining=.24;
      Object.assign(largeWhitehead,{linkedPore:false,sharedPore:null,giftId:null,blackheadCount:1,blackheadLengths:[1],
        blackheadSize:'normal',whiteheadSize:'large',state:P_STATE.HEALED,healProgress:1,iced:false,
        x:state.width*.76,y:state.height*.72,bloodDropSize:0,serousDropSize:0});
      largeWhitehead.nx=largeWhitehead.x/state.width;largeWhitehead.ny=largeWhitehead.y/state.height;
      startMirrorPinch({x:together.x+38,y:together.y});
      state.pointer.squeezeForce=.42;state.pointer.rawForce=.42;
      updateHUD();setHint('长长短短，一起取出。');
      window.sharedShotSimulation=updateSimulation;updateSimulation=()=>{};
      // Inspect the actual tool renderer before repainting the scene. With
      // active squeeze it must leave a transparent layer, without any fingers.
      ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.restore();
      renderRealisticHandsAndTools();
      const toolPixels=ctx.getImageData(0,0,canvas.width,canvas.height).data.some((value,index)=>index%4===3&&value>0);
      // Observe the real bundle renderer; every strand must keep a pale body,
      // a separate dark terminal cap and exactly the same source opening.
      const strands=[],drawFilament=renderRealisticSebumFilament;
      const probe=document.createElement('canvas');
      const probeCtx=probe.getContext('2d',{willReadFrequently:true});
      renderRealisticSebumFilament=(targetCtx,points,...args)=>{
        const tip=points[points.length-1],middle=points[Math.floor(points.length*.5)];
        const origin=Math.ceil(Math.max(96,...points.flatMap(point=>[Math.abs(point.x),Math.abs(point.y)])))+16;
        probe.width=probe.height=origin*2;probeCtx.translate(origin,origin);
        drawFilament(probeCtx,points,...args);
        const pixel=point=>Array.from(probeCtx.getImageData(Math.floor(point.x+origin),Math.floor(point.y+origin),1,1).data);
        strands.push({root:{x:points[0].x,y:points[0].y},tip:{x:tip.x,y:tip.y},
          length:points.reduce((total,point,index)=>total+(index?Math.hypot(point.x-points[index-1].x,point.y-points[index-1].y):0),0),
          darkTip:tip.hasDarkCap===true,bodyPixel:pixel(middle),tipPixel:pixel(tip),
          inCanvas:points.every(point=>bundle.x+point.x>=0&&bundle.x+point.x<=state.width
            &&bundle.y+point.y>=0&&bundle.y+point.y<=state.height)});
        return drawFilament(targetCtx,points,...args);
      };
      try{renderPimple(bundle,state.styleMode==='creamy');}finally{renderRealisticSebumFilament=drawFilament;}
      renderScene(false);requestSceneFrame();
      return {active:state.pointer.active,tool:state.currentTool,mode:state.pointer.mode,toolPixels,
        bundleCount:bundle.blackheadCount,bundleSize:bundle.blackheadSize,bundleLengths:bundle.blackheadLengths,bundleStrands:strands,
        thickness:getBlackheadRenderData(bundle).thickness,
        normalThickness:getBlackheadRenderData({...bundle,blackheadSize:'normal'}).thickness,
        pores:state.pimples.map(p=>({id:p.id,type:p.type,state:p.state,shared:p.sharedPore,
          blackheadCount:p.blackheadCount,whiteheadSize:p.whiteheadSize,iced:p.iced,mouths:getPimpleMouths(p)}))};
    })()`);
    assert.equal(shared.active,true,`${label}: shared-opening screenshot holds squeeze active`);
    assert.equal(shared.tool,'squeeze');
    assert.equal(shared.toolPixels,false,`${label}: squeezing draws no finger overlay`);
    assert.deepEqual(shared.pores.map(p=>[p.shared?.mode||(p.type==='whitehead'?'large-whitehead':'bundle'),p.shared?.phase||p.type,p.mouths.length]),
      [['together','blackhead',1],['sequential','whitehead',1],['bundle','blackhead',1],['large-whitehead','whitehead',1]],
      `${label}: each contents variant uses one opening`);
    assert.equal(shared.bundleCount,4,`${label}: the third opening contains four blackheads`);
    assert.equal(shared.bundleSize,'giant');
    assert.ok(shared.thickness>shared.normalThickness,`${label}: the giant bundle renders visibly thicker than an ordinary one`);
    assert.equal(shared.pores[3].whiteheadSize,'large');assert.equal(shared.pores[3].iced,false);
    assert.equal(shared.bundleStrands.length,4,`${label}: all four blackheads reach the actual filament renderer`);
    assert.ok(shared.bundleStrands.every(strand=>strand.darkTip&&strand.inCanvas
      &&strand.bodyPixel.slice(0,3).reduce((sum,value)=>sum+value,0)/3>170
      &&strand.tipPixel.slice(0,3).reduce((sum,value)=>sum+value,0)/3<110
      &&strand.bodyPixel[3]>180&&strand.tipPixel[3]>180),
      `${label}: four dark tips and pale bodies remain inside the mobile canvas`);
    assert.ok(shared.bundleStrands.every(strand=>JSON.stringify(strand.root)===JSON.stringify(shared.bundleStrands[0].root)),
      `${label}: the four strands grow from one opening`);
    assert.equal(new Set(shared.bundleStrands.map(strand=>JSON.stringify(strand.tip))).size,4,
      `${label}: the four tips stay visually separated`);
    const lengths=shared.bundleStrands.map(strand=>strand.length);
    assert.ok(Math.max(...lengths)>Math.min(...lengths)*1.5,`${label}: the bundle visibly mixes long and short strands`);
    report.sharedPores.push({viewport:label,...shared});
    await checkpoint('11-shared-openings-squeeze', null);
    await evaluate('updateSimulation=window.sharedShotSimulation;delete window.sharedShotSimulation;releasePointer();');
    if(viewport.name==='phone') {
      const regions=await evaluate('TREATMENT_REGIONS.map(region=>({id:region.id,label:region.label}))');
      assert.equal(regions.length,5);
      let boardBounds=null;
      for(const [index,region] of regions.entries()) {
        await evaluate(roundFixtureSource({level:8,region:region.id,keepPlan:true}));
        await evaluate('finishPracticeGuide(true);renderSkinTexture();renderScene(false);updateHUD();');
        const geometry=()=>evaluate(`(() => {
          const box=canvas.getBoundingClientRect();
          return {board:{left:box.left,top:box.top,width:box.width,height:box.height,
            bufferWidth:canvas.width,bufferHeight:canvas.height},
            targets:state.pimples.map(p=>({id:p.id,x:p.x,y:p.y,radius:p.radius}))};
        })()`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const baseline=await geometry();
        if(boardBounds)assert.deepEqual(baseline.board,boardBounds,'switching treatment regions keeps the same canvas space');
        else boardBounds=baseline.board;
        assert.equal(await evaluate('currentTreatmentRegion().id'),region.id);
        const points=await evaluate(`(() => {
          const bounds=canvas.getBoundingClientRect(),p=state.pimples[0];
          return [{x:bounds.left+p.x/state.width*bounds.width,y:bounds.top+p.y/state.height*bounds.height},
            {x:bounds.left+3,y:bounds.top+3}];
        })()`);
        for(const point of points) {
          await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point,pointerType:'mouse',button:'none',buttons:0});
          await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          assert.deepEqual(await geometry(),baseline,`${region.id}: guidance hover never moves the board or targets`);
        }
        report.regions.push({viewport:label,region:region.id,label:region.label,geometryStable:true,geometry:baseline});
        await checkpoint(`${String(12+index).padStart(2,'0')}-region-${region.id}`,null);
      }
    }
  } finally {
    for (const error of cdp.errors.get(sessionId) || []) report.failures.push(`${label}: runtime error: ${error}`);
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

async function main() {
  await fsp.mkdir(OUTPUT, { recursive: true });
  const report = { viewports: VIEWPORTS, screens: [], fonts: [], geometry: [], giftFlights: [], feeding: [], sharedPores: [], regions: [], audio: [], failures: [] };
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
  } else console.log(`Browser QA passed: ${report.screens.length} screenshots; stable interaction geometry across ${report.geometry.length} viewports.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
