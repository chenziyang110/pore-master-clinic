const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('./harness.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const PROFILE = 'pimple_clinic_profile_v3';

async function game(t, options = {}) {
  const g = await createGame({ seed: 75241, ...options });
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  // Keep real DOM input and simulation. Drawing checks invoke the real canvas
  // functions below, without painting every intermediate mechanics frame.
  g.evaluate('renderScene = () => {};');
  return g;
}

function startLevel(g, level) {
  g.evaluate(`wardrobeProgress.level=${level};state.runLevel=${level};generateLevel(0);
    state.paused=false;selectTool('steam');saveCurrentSession(true);`);
  g.frame();
  return g.state('state.pimples.find(p => p.blackheadCount > 1)');
}

function key(g, value, type = 'keydown') {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent(type,
    { key: value, bubbles: true, cancelable: true }));
}

function select(g, p) {
  g.d.getElementById('skin-canvas').focus();
  for (let i = 0; i < 100; i++) {
    if (g.state('currentKeyboardTarget()?.item.id') === p.id) return;
    key(g, 'ArrowRight');
  }
  throw new Error(`Cannot select bundle ${p.id}`);
}

function hold(g, seconds) {
  key(g, ' '); g.frame(Math.ceil(seconds / .05), 50); key(g, ' ', 'keyup');
}

function warm(g, p) {
  select(g, p); key(g, '1'); hold(g, 3);
  assert.equal(p.steamed, 1);
}

function squeeze(g, p, until) {
  select(g, p); key(g, '3'); key(g, ' ');
  let frames = 0;
  while (!until() && frames++ < 240) g.frame(1, 50);
  key(g, ' ', 'keyup');
  assert.ok(frames < 240, 'a real gentle hold advances the whole bundle');
}

function pull(g, p, fromExposedTip = false) {
  const mouth = plain(g.state(`getPimpleMouths(state.pimples.find(p => p.id === ${p.id}))`));
  const start = fromExposedTip ? g.evaluate(`(() => {
    const p=state.pimples.find(p=>p.id===${p.id});
    return blackheadBundleCurves(computeRealisticBlackheadCurve(p,p.extrudeProgress,p.x,p.y),p.blackheadCount)[0].at(-1);
  })()`) : { x: p.x, y: p.y };
  const direction = start.x < g.state('state.width') / 2 ? 1 : -1;
  g.click('tool-tweezers');
  g.mouse('skin-canvas', 'mousedown', start.x, start.y);
  assert.equal(g.state('state.tweezers.clampedPimple?.id'), p.id, 'any exposed tip selects its one owning pore');
  for (let step = 1; step <= 16; step++) {
    g.mouse(g.w, 'mousemove', start.x + direction * step * 2, start.y);
    g.frame();
    assert.deepEqual(plain(g.state(`getPimpleMouths(state.pimples.find(p => p.id === ${p.id}))`)), mouth,
      'the opening does not move as all strands are pulled out');
  }
  g.mouse(g.w, 'mouseup', start.x + direction * 32, start.y);
}

function wipe(g, p) {
  select(g, p); key(g, '5'); hold(g, 2); g.frame(60);
}

function drawnStrands(g, statement) {
  return plain(g.evaluate(`(() => {
    const observed=[], draw=renderRealisticSebumFilament;
    renderRealisticSebumFilament=(context,points,...args)=>{
      observed.push({root:{x:points[0].x,y:points[0].y},tip:{x:points.at(-1).x,y:points.at(-1).y},dark:points.at(-1).hasDarkCap});
      draw(context,points,...args);
    };
    try { ${statement} } finally { renderRealisticSebumFilament=draw; }
    return observed;
  })()`));
}

function assertBundle(strands, count) {
  assert.equal(strands.length, count, 'every saved strand reaches the actual canvas renderer');
  for (const strand of strands) {
    assert.deepEqual(strand.root, strands[0].root, 'all roots use one opening');
    assert.equal(strand.dark, true, 'each ivory body has its own dark terminal cap');
  }
  for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) {
    assert.ok(Math.hypot(strands[a].tip.x - strands[b].tip.x, strands[a].tip.y - strands[b].tip.y) > 2.4,
      'separate tips remain visible instead of being drawn on top of one another');
  }
}

test('one bundle appears from level five, cycles through two to four strands, and remains separate from other pore variants', async t => {
  const g = await game(t);
  for (const level of [1, 2, 3, 4]) {
    startLevel(g, level);
    assert.equal(g.state('state.pimples.some(p => p.blackheadCount > 1)'), false);
  }
  for (const [level, count] of [[5, 2], [6, 3], [7, 4]]) {
    const p = startLevel(g, level);
    assert.equal(g.state('state.pimples.filter(p => p.blackheadCount > 1).length'), 1);
    assert.equal(p.blackheadCount, count);
    assert.equal(p.type, 'blackhead');
    assert.equal(p.linkedPore, false);
    assert.equal(p.sharedPore, null);
    assert.deepEqual(plain(g.state(`getPimpleMouths(state.pimples.find(p=>p.id===${p.id}))`)), [{x:p.x,y:p.y}]);
    assert.match(g.state(`toolGuidanceFor('steam',{kind:'pimple',item:state.pimples.find(p=>p.id===${p.id})})`), new RegExp(`${count} 根黑头`));
  }
});

test('real heat and squeeze expose every strand with one root and distinct dark tips for two, three and four blackheads', async t => {
  const g = await game(t);
  for (const level of [5, 6, 7]) {
    const p = startLevel(g, level);
    warm(g, p);
    squeeze(g, p, () => p.state === 2 && p.extrudeProgress > .42);
    assertBundle(drawnStrands(g, `renderPimple(state.pimples.find(p=>p.id===${p.id}),false);`), p.blackheadCount);
    assert.equal(p.bloodDropSize, 0);
    assert.equal(g.state(`state.collectionLedger['blackhead:${p.id}']`), undefined);
  }
});

test('grabbing an outer tip removes the bundle once and preserves four strands through flight, reload and the tray', async t => {
  const g = await game(t), p = startLevel(g, 7);
  const id = p.id, origin = {x:p.x,y:p.y}, run = g.state('state.runId');
  warm(g, p);
  squeeze(g, p, () => p.state === 2 && p.extrudeProgress > .50);
  pull(g, p, true);
  assert.ok(p.state >= 4);
  assert.equal(p.bloodDropSize, 0);
  assert.equal(g.state('state.flyingTrophies.length'), 1);
  assert.equal(g.state(`state.collectionLedger['blackhead:${id}'].blackheadCount`), 4);
  assertBundle(drawnStrands(g, 'renderTrophyDishAndFlyingPlugs(state.width);'), 4);
  const score = g.state('state.score');
  g.evaluate('saveCurrentSession(true);');
  const saved = g.storage(); g.close();

  const r = await game(t, {storage:saved,seed:19});
  const restored = r.state(`state.pimples.find(p=>p.id===${id})`);
  assert.equal(r.state('state.runId'), run);
  assert.equal(restored.blackheadCount, 4);
  assert.deepEqual({x:restored.x,y:restored.y}, origin);
  assert.equal(r.state(`state.collectionLedger['blackhead:${id}'].blackheadCount`), 4);
  assert.equal(r.state('state.score'), score);
  assertBundle(drawnStrands(r, 'renderTrophyDishAndFlyingPlugs(state.width);'), 4);
  r.frame(40);
  assert.equal(r.state('state.trophiesPlucked'), 1, 'one bundle is one combined collectible');
  assert.equal(r.state('state.trophyTrayItems.length'), 1);
  assertBundle(drawnStrands(r, 'renderTrophyDishAndFlyingPlugs(state.width);'), 4);
  wipe(r, restored); wipe(r, restored);
  assert.equal(r.state('state.score'), score);
  assert.equal(r.state('state.trophiesPlucked'), 1);
});

test('a squeezed bundle keeps its three strands on the skin across reload and a real swab collects the group once', async t => {
  const g = await game(t), p = startLevel(g, 6);
  warm(g, p); squeeze(g, p, () => p.state === 3);
  const id = p.id;
  assert.equal(p.bloodDropSize, 0);
  assert.equal(g.state(`state.surfaceResidues.filter(r=>r.pimpleId===${id}).length`), 1);
  assert.equal(g.state(`state.collectionLedger['blackhead:${id}'].blackheadCount`), 3);
  assertBundle(drawnStrands(g, 'renderSurfaceResidues(false);'), 3);
  g.evaluate('saveCurrentSession(true);');
  const saved = g.storage();
  const damaged = JSON.parse(saved[PROFILE]).session;
  damaged.data.collectionLedger[`blackhead:${id}`].blackheadCount = 2;
  assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(damaged))})`), false,
    'a damaged collection cannot silently lose one strand during reload');
  g.close();

  const r = await game(t, {storage:saved});
  const restored = r.state(`state.pimples.find(p=>p.id===${id})`);
  assert.equal(restored.state, 3);
  assert.equal(restored.blackheadCount, 3);
  assertBundle(drawnStrands(r, 'renderSurfaceResidues(false);'), 3);
  wipe(r, restored);
  assert.ok(restored.state >= 4);
  assert.equal(r.state(`state.surfaceResidues.some(item=>item.pimpleId===${id})`), false);
  assert.equal(r.state('state.trophiesPlucked'), 1);
  assert.equal(r.state(`state.collectionLedger['blackhead:${id}'].rewards.extract`), true);
  assertBundle(drawnStrands(r, 'renderTrophyDishAndFlyingPlugs(state.width);'), 3);
  const score = r.state('state.score');
  wipe(r, restored);
  assert.equal(r.state('state.score'), score);
});

test('old saves default to one strand, while invalid bundle counts and mixed pore variants are rejected', async t => {
  const g = await game(t);
  startLevel(g, 1);
  const old = JSON.parse(g.storage()[PROFILE]).session;
  for (const p of [...old.data.pimples, ...old.data.initialPimples]) delete p.blackheadCount;
  assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(old))})`), true);
  assert.equal(g.state('state.pimples.every(p=>p.blackheadCount===1)'), true);

  const bundle = startLevel(g, 5), run = g.state('state.runId');
  const source = JSON.parse(g.storage()[PROFILE]).session;
  for (const bad of [0, 5, 2.5, '3', null]) {
    const damaged = plain(source);
    damaged.data.pimples.find(p=>p.id===bundle.id).blackheadCount = bad;
    assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(damaged))})`), false);
    assert.equal(g.state('state.runId'), run);
  }
  for (const owner of ['linkedPore', 'sharedPore', 'whitehead']) {
    const damaged = plain(source), p = damaged.data.pimples.find(p=>p.id===bundle.id);
    if (owner === 'linkedPore') p.linkedPore = true;
    else if (owner === 'sharedPore') p.sharedPore = {mode:'together',phase:'blackhead'};
    else p.type = 'whitehead';
    assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(damaged))})`), false);
  }
});
