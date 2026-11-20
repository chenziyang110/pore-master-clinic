const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('./harness.cjs');
const { setupRound } = require('./round-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));

async function game(t, options = {}) {
  const g = await createGame({ seed: 62406, ...options });
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  // Input, simulation, persistence and individual drawing functions stay real.
  // Avoid painting the full scene hundreds of times in mechanics checks.
  g.evaluate('renderScene = () => {};');
  return g;
}

function startShared(g, mode) {
  setupRound(g,{level:6,setup:`state.pimples[0].sharedPore={mode:${JSON.stringify(mode)},phase:'blackhead'};`});
  return g.state('state.pimples[0]');
}

function key(g, value, type = 'keydown') {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent(type,
    { key: value, bubbles: true, cancelable: true }));
}

function selectTarget(g, id) {
  g.d.getElementById('skin-canvas').focus();
  for (let i = 0; i < 100; i++) {
    if (g.state('currentKeyboardTarget()?.item.id') === id) return;
    key(g, 'ArrowRight');
  }
  throw new Error(`Cannot select pore ${id}`);
}

function hold(g, seconds) {
  key(g, ' '); g.frame(Math.ceil(seconds / .05), 50); key(g, ' ', 'keyup');
}

function warm(g, p) {
  selectTarget(g, p.id); key(g, '1'); hold(g, 3);
  assert.equal(p.steamed, 1, 'heat comes from the real held tool');
}

function squeezeUntil(g, p, predicate) {
  selectTarget(g, p.id); key(g, '3'); key(g, ' ');
  let frames = 0;
  while (!predicate() && frames++ < 240) g.frame(1, 50);
  key(g, ' ', 'keyup');
  assert.ok(frames < 240, 'gentle held squeeze reaches the expected content stage');
}

function pull(g, p) {
  const origin = plain(g.state(`getPimpleMouths(state.pimples.find(p => p.id === ${p.id}))`));
  const direction = p.x < g.state('state.width') / 2 ? 1 : -1;
  g.click('tool-tweezers');
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  assert.equal(g.state('state.tweezers.clampedPimple?.id'), p.id);
  for (let step = 1; step <= 16; step++) {
    g.mouse(g.w, 'mousemove', p.x + direction * step * 2, p.y);
    g.frame();
    if (p.sharedPore) assert.deepEqual(plain(g.state(`getPimpleMouths(state.pimples.find(p => p.id === ${p.id}))`)), origin,
      'the shared opening stays fixed throughout the physical drag');
  }
  g.mouse(g.w, 'mouseup', p.x + direction * 32, p.y);
  g.frame(35);
}

function wipe(g, p) {
  selectTarget(g, p.id); key(g, '5'); hold(g, 2); g.frame(60);
}

test('introductory boards have no shared contents and both shared modes use one stable opening', async t => {
  const g = await game(t);
  for (const level of [1, 2]) {
    g.evaluate(`wardrobeProgress.level=${level};generateLevel(0);`);
    assert.equal(g.state('state.pimples.some(p => p.sharedPore)'), false);
  }
  for (const mode of ['together','sequential']) {
    const p = startShared(g, mode);
    assert.equal(g.state('state.pimples.filter(p => p.sharedPore).length'), 1);
    assert.equal(p.linkedPore, false);
    assert.equal(p.type, 'blackhead');
    assert.equal(p.sharedPore.phase, 'blackhead');
    assert.equal(p.sharedPore.mode, mode);
    assert.deepEqual(plain(g.state(`getPimpleMouths(state.pimples.find(p => p.id === ${p.id}))`)), [{ x: p.x, y: p.y }]);
  }
});

test('together mode exposes both contents, removes visible squeezing fingers, and collects the pair once', async t => {
  const g = await game(t), p = startShared(g, 'together');
  warm(g, p);
  squeezeUntil(g, p, () => p.state === 2 && p.extrudeProgress > .30);
  const drawn = plain(g.evaluate(`(() => {
    const p = state.pimples.find(p => p.id === ${p.id}), observed = [];
    const draw = renderRealisticSebumFilament;
    renderRealisticSebumFilament = (context, points, ...args) => {
      observed.push({ root: {x:points[0].x,y:points[0].y}, tip: {x:points.at(-1).x,y:points.at(-1).y}, dark: points.at(-1).hasDarkCap });
      draw(context, points, ...args);
    };
    try { renderPimple(p, false); } finally { renderRealisticSebumFilament = draw; }
    return observed;
  })()`));
  assert.equal(drawn.length, 2, 'both strands are actually sent to the canvas renderer');
  assert.deepEqual(drawn[0].root, drawn[1].root, 'both contents rise from the same opening');
  assert.notDeepEqual(drawn[0].tip, drawn[1].tip, 'the white content is visibly separate');
  assert.deepEqual(drawn.map(strand => strand.dark), [true, false]);
  assert.equal(p.bloodDropSize, 0);

  // Resume a real held squeeze, then inspect only the tool layer: it must draw
  // no fingers while the separate skin deformation remains present.
  selectTarget(g, p.id); key(g, '3'); key(g, ' '); g.frame(2);
  const layers = plain(g.evaluate(`(() => {
    const clear = () => {ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.restore();};
    const visible = () => ctx.getImageData(0,0,canvas.width,canvas.height).data.some((value,index) => index % 4 === 3 && value > 0);
    clear();renderRealisticHandsAndTools();const fingers = visible();
    clear();renderRealPinchedSkinMesh(state.pointer);const skin = visible();
    return {fingers,skin};
  })()`));
  key(g, ' ', 'keyup');
  assert.deepEqual(layers, { fingers: false, skin: true });

  pull(g, p);
  assert.equal(p.sharedPore.phase, 'done');
  assert.ok(p.state >= 4);
  assert.equal(p.bloodDropSize, 0);
  const ledger = g.state(`state.collectionLedger['blackhead:${p.id}']`);
  assert.equal(ledger.location, 'tray');
  assert.equal(ledger.pairedWhitehead, true);
  assert.equal(ledger.rewards.extract, true);
  assert.equal(g.state('state.trophiesPlucked + state.coreSeedsCollected'), 1, 'one paired collectible belongs to one care point');
  const score = g.state('state.score');
  wipe(g, p); wipe(g, p);
  assert.equal(g.state('state.score'), score);
  assert.equal(g.state('state.trophyTrayItems.length'), 1);
});

test('a fully squeezed pair remains visible on the skin and a real swab collects both as one item', async t => {
  const g = await game(t), p = startShared(g, 'together');
  warm(g, p);
  squeezeUntil(g, p, () => p.state === 3);
  assert.equal(p.sharedPore.phase, 'done');
  assert.equal(p.bloodDropSize, 0);
  const residue = g.state(`state.surfaceResidues.find(item => item.pimpleId === ${p.id})`);
  assert.ok(residue && residue.kind === 'worm');
  assert.equal(g.state(`state.collectionLedger['blackhead:${p.id}'].pairedWhitehead`), true);
  wipe(g, p);
  assert.ok(p.state >= 4);
  assert.equal(g.state('state.trophiesPlucked'), 1);
  assert.equal(g.state('state.coreSeedsCollected'), 0);
  assert.equal(g.state(`state.surfaceResidues.some(item => item.pimpleId === ${p.id})`), false);
});

test('sequential contents survive a reload after the first pluck and the second content stays interactive', async t => {
  const g = await game(t), p = startShared(g, 'sequential');
  const origin = { id: p.id, x: p.x, y: p.y, radius: p.radius };
  const run = g.state('state.runId');
  warm(g, p); pull(g, p);
  assert.equal(p.sharedPore.phase, 'whitehead');
  assert.equal(p.type, 'whitehead');
  assert.equal(p.state, 2);
  assert.equal(p.bloodDropSize, 0);
  assert.equal(g.state(`canTweezePimple(state.pimples.find(p => p.id === ${p.id}))`), true);
  assert.equal(g.d.getElementById('btn-ice-quick').classList.contains('show'), false);
  assert.equal(g.state(`state.collectionLedger['seed:${p.id}']`), undefined);
  const scoreAfterBlack = g.state('state.score');
  g.evaluate('saveCurrentSession(true);');
  const saved = g.storage();
  const damaged = JSON.parse(saved.pimple_clinic_profile_v3).session;
  damaged.data.pimples.find(item => item.id === p.id).state = 4;
  assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(damaged))})`), false,
    'a saved active whitehead cannot claim the pore is already healed');
  assert.equal(g.state('state.runId'), run);
  assert.equal(p.state, 2);
  g.close();

  const r = await game(t, { storage: saved, seed: 99 });
  const remaining = r.state(`state.pimples.find(p => p.id === ${p.id})`);
  assert.equal(r.state('state.runId'), run);
  assert.deepEqual({ id: remaining.id, x: remaining.x, y: remaining.y, radius: remaining.radius }, origin);
  assert.equal(remaining.sharedPore.phase, 'whitehead');
  assert.equal(remaining.type, 'whitehead');
  assert.equal(remaining.state, 2);
  assert.equal(r.state('state.score'), scoreAfterBlack);
  assert.equal(r.state('state.trophiesPlucked'), 1);
  assert.equal(r.d.getElementById('btn-ice-quick').classList.contains('show'), false);
  squeezeUntil(r, remaining, () => remaining.state === 3);
  assert.equal(remaining.sharedPore.phase, 'done');
  assert.equal(remaining.bloodDropSize, 0, 'gentle whitehead care does not routinely bleed');
  wipe(r, remaining);
  assert.ok(remaining.state >= 4);
  assert.equal(r.state('state.trophiesPlucked'), 1);
  assert.equal(r.state('state.coreSeedsCollected'), 1);
  assert.equal(r.state(`state.collectionLedger['blackhead:${p.id}'].rewards.extract`), true);
  assert.equal(r.state(`state.collectionLedger['seed:${p.id}'].rewards.extract`), true);
  const completeScore = r.state('state.score');
  wipe(r, remaining); wipe(r, remaining);
  assert.equal(r.state('state.score'), completeScore, 'revisiting an emptied shared pore cannot pay again');
  r.evaluate('saveCurrentSession(true);');
  const completed = r.storage(); r.close();
  const again = await game(t, { storage: completed });
  assert.equal(again.state(`state.pimples.find(p => p.id === ${p.id}).sharedPore.phase`), 'done');
  assert.equal(again.state('state.score'), completeScore);
  assert.equal(again.state('state.trophiesPlucked + state.coreSeedsCollected'), 2);
});

test('wiping away the first squeezed plug cannot finish the remaining whitehead; it can then be plucked normally', async t => {
  const g = await game(t), p = startShared(g, 'sequential');
  warm(g, p);
  squeezeUntil(g, p, () => p.sharedPore.phase === 'whitehead');
  assert.equal(p.state, 2);
  assert.equal(g.state(`state.surfaceResidues.some(item => item.pimpleId === ${p.id} && item.kind === 'worm')`), true);
  wipe(g, p);
  assert.equal(g.state('state.trophiesPlucked'), 1);
  assert.equal(p.state, 2, 'cleaning the old black plug leaves the second content active');
  assert.equal(p.sharedPore.phase, 'whitehead');
  assert.equal(g.d.getElementById('btn-ice-quick').classList.contains('show'), false);
  pull(g, p);
  assert.equal(p.sharedPore.phase, 'done');
  assert.equal(p.state, 3, 'the second pluck still requires the normal surface cleanup');
  wipe(g, p);
  assert.ok(p.state >= 4);
  assert.equal(g.state('state.trophiesPlucked'), 1);
  assert.equal(g.state('state.coreSeedsCollected'), 1);
});
