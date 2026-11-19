const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');

function countedWindow(window) {
  const schedule = window.requestAnimationFrame;
  window.frameCallbacks = 0;
  window.requestAnimationFrame = callback => schedule(time => {
    window.frameCallbacks++;
    callback(time);
  });
}

function countPaints(game) {
  game.evaluate(`window.scenePaints = 0;
    window.realSceneRender = renderScene;
    renderScene = (...args) => { if (!args[0]) window.scenePaints++; return window.realSceneRender(...args); };`);
}

test('a stationary board sleeps and pointer, keyboard, style and resize changes wake it', async t => {
  const g = await createGame({seed:6, setupWindow:countedWindow}); t.after(g.close);
  g.frame(3); countPaints(g);
  const callbacks = g.w.frameCallbacks;
  g.frame(600);
  assert.equal(g.w.frameCallbacks, callbacks, 'ten seconds at rest requests no animation callbacks');
  assert.equal(g.w.scenePaints, 0);

  g.mouse(g.w, 'mousemove', 100, 150); g.frame();
  assert.equal(g.w.scenePaints, 1, 'hovered tools still follow the pointer');
  g.frame(60); assert.equal(g.w.scenePaints, 1);
  const canvas = g.d.getElementById('skin-canvas');
  canvas.focus();
  canvas.dispatchEvent(new g.w.KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true})); g.frame();
  assert.equal(g.w.scenePaints, 2, 'keyboard target selection wakes the board');
  const before = g.pixels.get(canvas).canvas.toBuffer('image/png');
  g.click('btn-style-mode'); g.frame();
  assert.notDeepEqual(g.pixels.get(canvas).canvas.toBuffer('image/png'), before);
  g.resize(420,580); g.frame();
  assert.equal(canvas.width,420);
  assert.equal(g.w.scenePaints,4);
  g.frame(60); assert.equal(g.w.scenePaints,4);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('modal, hidden and readonly pages stop scheduling, then resume without a held action', async t => {
  const hub = createStorageHub(); t.after(hub.close);
  const g = await createGame({storageHub:hub,seed:9,setupWindow:countedWindow}); t.after(g.close);
  g.frame(3);
  g.click('tool-needle');
  g.mouse('skin-canvas','mousedown',100,150); g.frame(3);
  g.click('btn-help'); const paused = g.w.frameCallbacks;
  g.frame(120); assert.equal(g.w.frameCallbacks,paused);
  assert.equal(g.state('state.pointer.active'),false);
  g.click('btn-close-help'); g.frame();
  assert.equal(g.w.frameCallbacks,paused+1);

  Object.defineProperty(g.d,'hidden',{configurable:true,value:true});
  g.d.dispatchEvent(new g.w.Event('visibilitychange'));
  g.frame(120); assert.equal(g.w.frameCallbacks,paused+1);
  Object.defineProperty(g.d,'hidden',{configurable:true,value:false});
  g.d.dispatchEvent(new g.w.Event('visibilitychange')); g.frame();
  assert.equal(g.w.frameCallbacks,paused+2);

  const second = await createGame({storageHub:hub,setupWindow:countedWindow}); t.after(second.close);
  second.frame(3); const blocked = second.w.frameCallbacks;
  second.frame(120); assert.equal(second.w.frameCallbacks,blocked);
  second.click('btn-continue-here'); await second.evaluate('careControlReady');
  second.frame(); assert.ok(second.w.frameCallbacks>blocked,'a newly acquired page wakes after asynchronous handoff');
  g.frame(); const former = g.w.frameCallbacks;
  g.frame(120); assert.equal(g.w.frameCallbacks,former);
  assert.deepEqual(g.runtimeErrors,[]); assert.deepEqual(second.runtimeErrors,[]);
});

test('120 Hz displays repaint active tools at 60 fps while held care follows elapsed time', async t => {
  const scores = [];
  for (const hz of [60,120,144]) {
    const g = await createGame({seed:12}); t.after(g.close); g.frame(3); countPaints(g);
    const p = g.state('state.pimples.find(p=>p.type==="blackhead")');
    g.mouse('skin-canvas','mousedown',p.x,p.y);
    g.frame(hz,1000/hz);
    scores.push(p.steamed);
    assert.ok(g.w.scenePaints>=58 && g.w.scenePaints<=61, `${hz} Hz rendered ${g.w.scenePaints} times`);
    g.mouse(g.w,'mouseup',p.x,p.y);
    assert.deepEqual(g.runtimeErrors,[]);
  }
  assert.ok(Math.max(...scores)-Math.min(...scores)<0.012,'heat progress is consistent across screen refresh rates');
});

test('force and hand smoothing use elapsed time at 30, 60 and 120 updates per second', async t => {
  const outcomes = [];
  for (const hz of [30,60,120]) {
    const g = await createGame({seed:5}); t.after(g.close);
    g.evaluate(`Object.assign(state.pointer,{active:true,mode:'two-finger',rawForce:.35,squeezeForce:0,lockedPimple:null,
      p1:{x:100,y:120},p2:{x:180,y:120},smoothP1:{x:0,y:0},smoothP2:{x:0,y:0}});
      for(let step=0;step<${hz/10};step++)updateSimulation(${1/hz});`);
    outcomes.push(g.state('({force:state.pointer.squeezeForce,x:state.pointer.smoothP1.x})'));
  }
  for(const outcome of outcomes.slice(1)) {
    assert.ok(Math.abs(outcome.force-outcomes[0].force)<1e-10);
    assert.ok(Math.abs(outcome.x-outcomes[0].x)<1e-10);
  }
});

test('reduced motion keeps feedback and collection without flight, bouncing or drifting text', async t => {
  const g = await createGame({seed:7,setupWindow(window) {
    window.matchMedia = query => ({matches:query.includes('prefers-reduced-motion'),media:query,addEventListener(){}});
  }}); t.after(g.close); g.frame();
  g.evaluate(`spawnFloatingText(80,120,'已收集');
    launchTrophyToDish(80,120,'blackhead',24,'reduced:1');
    state.cameraShake=5;
    updateSimulation(.1);`);
  assert.equal(g.state('state.trophiesPlucked'),1);
  assert.equal(g.state('state.flyingTrophies.length'),0);
  assert.equal(g.state('state.collectionLedger["reduced:1"].location'),'tray');
  assert.equal(g.state('state.trayPulse'),0);
  assert.equal(g.state('state.cameraShake'),0);
  assert.equal(g.state('state.floatingTexts[0].y'),120);
  assert.equal(g.state('state.floatingTexts[0].text'),'已收集');
  g.evaluate('updateSimulation(1);');
  assert.equal(g.state('state.floatingTexts.length'),0);
  assert.deepEqual(g.runtimeErrors,[]);
});
