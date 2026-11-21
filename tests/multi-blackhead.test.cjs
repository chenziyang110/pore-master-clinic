const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('./harness.cjs');
const { setupRound } = require('./round-fixture.cjs');

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

function startBundle(g, {count=2,lengths=Array(count).fill(1),giant=false}={}) {
  setupRound(g,{level:6,setup:`Object.assign(state.pimples[0],{blackheadCount:${count},
    blackheadLengths:${JSON.stringify(lengths)},blackheadSize:${JSON.stringify(giant?'giant':'normal')}});`});
  return g.state('state.pimples[0]');
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
    const tip=getBlackheadRenderData(p).curves[0].at(-1);return {x:p.x+tip.x,y:p.y+tip.y};
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
      observed.push({root:{x:points[0].x,y:points[0].y},tip:{x:points.at(-1).x,y:points.at(-1).y},dark:points.at(-1).hasDarkCap,length:points.at(-1).distFromRoot});
      draw(context,points,...args);
    };
    try { ${statement} } finally { renderRealisticSebumFilament=draw; }
    return observed;
  })()`));
}

function assertBundle(strands, count, lengths = Array(count).fill(1)) {
  assert.equal(strands.length, count, 'every saved strand reaches the actual canvas renderer');
  for (const strand of strands) {
    assert.deepEqual(strand.root, strands[0].root, 'all roots use one opening');
    assert.equal(strand.dark, true, 'each ivory body has its own dark terminal cap');
  }
  for (let index = 0; index < count; index++) {
    assert.ok(Math.abs(strands[index].length / strands[0].length - lengths[index] / lengths[0]) < 1e-7,
      'the visible length ratio survives every collection stage');
  }
  for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) {
    assert.ok(Math.hypot(strands[a].tip.x - strands[b].tip.x, strands[a].tip.y - strands[b].tip.y) > 2.4,
      'separate tips remain visible instead of being drawn on top of one another');
  }
}

test('introductory boards stay simple and legacy two, three or four strands each use one unmixed opening', async t => {
  const g = await game(t);
  for (const level of [1, 2]) {
    g.evaluate(`wardrobeProgress.level=${level};generateLevel(0);`);
    assert.equal(g.state('state.pimples.some(p => p.blackheadCount > 1)'), false);
  }
  for (const count of [2,3,4]) {
    const p = startBundle(g,{count});
    assert.equal(p.blackheadCount,count);
    assert.equal(p.type, 'blackhead');
    assert.equal(p.linkedPore, false);
    assert.equal(p.sharedPore, null);
    assert.deepEqual(plain(g.state(`getPimpleMouths(state.pimples.find(p=>p.id===${p.id}))`)), [{x:p.x,y:p.y}]);
    assert.equal(g.state(`keyboardTargetDescription({kind:'pimple',item:state.pimples.find(p=>p.id===${p.id})})`), '黑头 · 待护理',
      'an unopened pore does not disclose the hidden strand count');
  }
});

test('real heat and squeeze preserve legacy two, three and four blackheads with one root and distinct dark tips', async t => {
  const g = await game(t);
  for (const count of [2,3,4]) {
    const p = startBundle(g,{count});
    warm(g, p);
    squeeze(g, p, () => p.state === 2 && p.extrudeProgress > .42);
    assertBundle(drawnStrands(g, `renderPimple(state.pimples.find(p=>p.id===${p.id}),false);`), p.blackheadCount, p.blackheadLengths);
    assert.match(g.state(`keyboardTargetDescription({kind:'pimple',item:state.pimples.find(p=>p.id===${p.id})})`), new RegExp(`${p.blackheadCount} 根黑头`));
    assert.equal(p.bloodDropSize, 0);
    assert.equal(g.state(`state.collectionLedger['blackhead:${p.id}']`), undefined);
  }
});

test('reload trims an unopened legacy four-strand bundle to a pair but preserves exposed legacy bundles', async t => {
  for (const {count, exposed} of [{count:4,exposed:false},{count:3,exposed:true},{count:4,exposed:true}]) {
    const g = await game(t), lengths = [.6,1,1.5,.8].slice(0,count);
    const p = startBundle(g,{count,lengths,giant:true});
    const id = p.id, run = g.state('state.runId');
    warm(g,p);
    if (exposed) squeeze(g,p,() => p.state === 2 && p.extrudeProgress > .42);
    else assert.equal(p.state,0,'warming alone does not reveal the old hidden bundle');
    assert.equal(g.state(`state.collectionLedger['blackhead:${id}']`),undefined,
      'these migration cases have no extracted collectible to rewrite');
    const before = {state:p.state,progress:p.extrudeProgress,steamed:p.steamed,score:g.state('state.score')};
    g.evaluate('saveCurrentSession(true);');
    const stored = g.storage();g.close();

    const r = await game(t,{storage:stored,seed:19});
    const restored = r.state(`state.pimples.find(p=>p.id===${id})`);
    const expectedCount = exposed ? count : 2;
    const expectedLengths = exposed ? lengths : lengths.slice(0,2);
    assert.equal(r.state('state.runId'),run,'migration resumes this run instead of replacing it');
    assert.equal(restored.blackheadCount,expectedCount);
    assert.deepEqual(plain(restored.blackheadLengths),expectedLengths);
    assert.equal(restored.blackheadSize,'giant');
    assert.deepEqual({state:restored.state,progress:restored.extrudeProgress,steamed:restored.steamed,score:r.state('state.score')},before,
      'the treatment state, current extrusion and earned score survive unchanged');
    assert.equal(r.state(`state.initialPimples.find(p=>p.id===${id}).blackheadCount`),expectedCount,
      'the saved initial contents use the same migrated or preserved bundle');
    assert.deepEqual(plain(r.state(`state.initialPimples.find(p=>p.id===${id}).blackheadLengths`)),expectedLengths);
    if (exposed) assertBundle(drawnStrands(r,`renderPimple(state.pimples.find(p=>p.id===${id}),false);`),count,lengths);
    r.evaluate('saveCurrentSession(true);');
    const saved = JSON.parse(r.storage()[PROFILE]).session;
    assert.equal(r.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(saved))})`),true,
      'the migrated or preserved snapshot remains valid on its next restore');
    assert.equal(r.state('state.runId'),run);
    assert.equal(r.state(`state.pimples.find(p=>p.id===${id}).blackheadCount`),expectedCount);
  }
});

test('grabbing an outer tip removes the legacy four-strand bundle once and preserves it through flight, reload and the tray', async t => {
  const g = await game(t), p = startBundle(g,{count:4,lengths:[.6,1,1.5,.8]});
  const id = p.id, origin = {x:p.x,y:p.y}, run = g.state('state.runId');
  warm(g, p);
  squeeze(g, p, () => p.state === 2 && p.extrudeProgress > .50);
  const lengths = plain(p.blackheadLengths);
  assert.ok(Math.max(...lengths) / Math.min(...lengths) > 2, 'the saved fixture contains visibly unequal strands');
  const tips = plain(g.state(`getBlackheadRenderData(state.pimples.find(p=>p.id===${id})).curves.map(curve=>curve.at(-1))`));
  for (const tip of tips) {
    g.click('tool-tweezers');
    g.mouse('skin-canvas', 'mousedown', p.x + tip.x, p.y + tip.y);
    assert.equal(g.state('state.tweezers.clampedPimple?.id'), id, 'each short or long tip is a real hit target');
    g.mouse(g.w, 'mouseup', p.x + tip.x, p.y + tip.y);
  }
  pull(g, p, true);
  assert.ok(p.state >= 4);
  assert.equal(p.bloodDropSize, 0);
  assert.equal(g.state('state.flyingTrophies.length'), 1);
  assert.equal(g.state(`state.collectionLedger['blackhead:${id}'].blackheadCount`), 4);
  assertBundle(drawnStrands(g, 'renderTrophyDishAndFlyingPlugs(state.width);'), 4, lengths);
  const score = g.state('state.score');
  g.evaluate('saveCurrentSession(true);');
  const saved = g.storage(); g.close();

  const r = await game(t, {storage:saved,seed:19});
  const restored = r.state(`state.pimples.find(p=>p.id===${id})`);
  assert.equal(r.state('state.runId'), run);
  assert.equal(restored.blackheadCount, 4);
  assert.deepEqual(plain(restored.blackheadLengths), lengths);
  assert.deepEqual({x:restored.x,y:restored.y}, origin);
  assert.equal(r.state(`state.collectionLedger['blackhead:${id}'].blackheadCount`), 4);
  assert.deepEqual(plain(r.state(`state.collectionLedger['blackhead:${id}'].blackheadLengths`)), lengths);
  assert.equal(r.state('state.score'), score);
  assertBundle(drawnStrands(r, 'renderTrophyDishAndFlyingPlugs(state.width);'), 4, lengths);
  r.frame(40);
  assert.equal(r.state('state.trophiesPlucked'), 1, 'one bundle is one combined collectible');
  assert.equal(r.state('state.trophyTrayItems.length'), 1);
  assertBundle(drawnStrands(r, 'renderTrophyDishAndFlyingPlugs(state.width);'), 4, lengths);
  wipe(r, restored); wipe(r, restored);
  assert.equal(r.state('state.score'), score);
  assert.equal(r.state('state.trophiesPlucked'), 1);
});

test('a squeezed legacy three-strand bundle stays on the skin across reload and a real swab collects the group once', async t => {
  const g = await game(t), p = startBundle(g,{count:3,giant:true});
  warm(g, p); squeeze(g, p, () => p.state === 3);
  const id = p.id;
  assert.equal(p.blackheadSize, 'giant');
  assert.equal(p.bloodDropSize, 0);
  assert.equal(g.state(`state.surfaceResidues.filter(r=>r.pimpleId===${id}).length`), 1);
  assert.equal(g.state(`state.collectionLedger['blackhead:${id}'].blackheadCount`), 3);
  assert.equal(g.state(`state.collectionLedger['blackhead:${id}'].blackheadSize`), 'giant');
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
  assert.equal(restored.blackheadSize, 'giant');
  assert.equal(r.state(`state.collectionLedger['blackhead:${id}'].blackheadSize`), 'giant');
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
  setupRound(g,{level:1,pace:'intro',recipe:{blackhead:3,whitehead:0,cyst:0}});
  const old = JSON.parse(g.storage()[PROFILE]).session;
  for (const p of [...old.data.pimples, ...old.data.initialPimples]) delete p.blackheadCount;
  assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(old))})`), true);
  assert.equal(g.state('state.pimples.every(p=>p.blackheadCount===1)'), true);

  const bundle = startBundle(g,{count:2}), run = g.state('state.runId');
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
