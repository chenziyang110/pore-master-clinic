const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('./harness.cjs');
const { setupRound } = require('./round-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const GROUP_IDS = [1, 2, 3];

async function game(t, options = {}) {
  const g = await createGame({ seed: 80317, width: 666, height: 550, ...options });
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  // Exercise real input, simulation and persistence without painting hundreds
  // of intermediate frames; the dedicated geometry suites cover the canvas.
  g.evaluate('renderScene = () => {};');
  return g;
}

function board(g, { primaryAhead = false, gifts = false } = {}) {
  setupRound(g, {
    level: 6, recipe: { blackhead: 5, whitehead: 1, cyst: 1 },
    setup: `
      const positions = [[180,220],[228,220],[180,268],[500,400],[228,268],[132,268],[132,172]];
      state.pimples.forEach((p,index) => {
        [p.x,p.y] = positions[index];
        p.nx = p.x / state.width; p.ny = p.y / state.height;
        p.targetAngle = 0; p.steamed = 1;
      });
      state.pimples[4].sharedPore = {mode:'sequential',phase:'blackhead'};
      ${primaryAhead ? 'state.pimples[0].state=P_STATE.EXTRUDING;state.pimples[0].extrudeProgress=.92;' : ''}
      ${gifts ? "['food_strawberry_cake','food_honey_toast','mask_pearl'].forEach((id,index)=>state.pimples[index].giftId=id);" : ''}
      state.practiceGuide.active = false;
    `
  });
  return g.state('state.pimples[0]');
}

function key(g, value, type = 'keydown') {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent(type,
    { key: value, bubbles: true, cancelable: true }));
}

function select(g, id) {
  g.d.getElementById('skin-canvas').focus();
  for (let i = 0; i < 80; i++) {
    const current = g.state('currentKeyboardTarget()');
    if (current?.kind === 'pimple' && current.item.id === id) return;
    key(g, 'ArrowRight');
  }
  throw new Error(`Cannot select pore ${id}`);
}

function beginMouse(g, p) {
  g.click('tool-squeeze');
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  g.mouse(g.w, 'mousemove', p.x + 28, p.y);
  assert.equal(g.state('state.pointer.lockedPimple?.id'), p.id);
}

function beginTouch(g, p) {
  g.click('tool-squeeze');
  const fingers = half => [
    { identifier: 11, clientX: p.x - half, clientY: p.y },
    { identifier: 22, clientX: p.x + half, clientY: p.y }
  ];
  g.touch('touchstart', fingers(48), fingers(48));
  g.touch('touchmove', fingers(38), fingers(38));
  assert.equal(g.state('state.pointer.mode'), 'two-finger');
  assert.equal(g.state('state.pointer.lockedPimple?.id'), p.id);
  return fingers(38);
}

function beginKeyboard(g, p) {
  select(g, p.id); key(g, '3'); key(g, ' ');
  assert.equal(g.state('state.keyboardCare.active'), true);
}

function until(g, predicate, message) {
  let frames = 0;
  while (!predicate() && frames++ < 240) g.frame(1, 50);
  assert.ok(frames < 240, message);
}

function groupDone(g) {
  return g.state(`state.pimples.filter(p=>${JSON.stringify(GROUP_IDS)}.includes(p.id)).every(p=>p.state>=P_STATE.OOZING)`);
}

function assertGroupAccounting(g) {
  const entries = plain(g.state('Object.entries(state.collectionLedger)'));
  assert.deepEqual(entries.map(([id]) => id).sort(), GROUP_IDS.map(id => `blackhead:${id}`));
  assert.ok(entries.every(([, value]) => value.rewards.extract === true));
  assert.deepEqual(plain(g.state("state.surfaceResidues.filter(r=>r.kind==='worm').map(r=>r.pimpleId).sort()")), GROUP_IDS);
  assert.equal(g.state('state.damage'), 0, 'finishing one member must not hurt an emptied primary while neighbors continue');
  assert.equal(g.state('state.pimples.some(p=>p.bloodDropSize>0)'), false);
}

test('one mouse squeeze finishes three neighboring blackheads after its primary empties and leaves other targets untouched', async t => {
  const g = await game(t), p = board(g, { primaryAhead: true });
  const untouched = plain(g.state('state.pimples.slice(3).map(p=>({id:p.id,state:p.state,pressure:p.pressure,extrudeProgress:p.extrudeProgress,type:p.type,phase:p.sharedPore?.phase}))'));
  beginMouse(g, p);
  until(g, () => p.state === 3, 'the already exposed primary finishes first');
  assert.equal(groupDone(g), false, 'the other two pores still require the held squeeze');
  assert.equal(g.state('state.pointer.active'), true, 'one exhausted pore does not stop the rest');
  until(g, () => groupDone(g), 'the same gesture finishes its nearby blackheads');
  g.frame(2, 50);
  assert.equal(g.state('state.pointer.active'), false, 'a completed group releases before empty-pore damage');
  assertGroupAccounting(g);
  assert.deepEqual(plain(g.state('state.pimples.slice(3).map(p=>({id:p.id,state:p.state,pressure:p.pressure,extrudeProgress:p.extrudeProgress,type:p.type,phase:p.sharedPore?.phase}))')), untouched,
    'a distant blackhead, a shared opening, a whitehead and a deep target remain untouched');
  const score = g.state('state.score');
  g.frame(60, 50);
  g.mouse(g.w, 'mouseup', p.x + 28, p.y);
  assertGroupAccounting(g);
  assert.equal(g.state('state.score'), score, 'continued frames and release cannot award the group twice');
});

test('two-finger and keyboard squeezing both finish slower neighbors after the selected pore empties', async t => {
  for (const input of ['touch', 'keyboard']) {
    const g = await game(t), p = board(g, { primaryAhead: true });
    const fingers = input === 'touch' ? beginTouch(g, p) : (beginKeyboard(g, p), null);
    until(g, () => p.state === 3, `${input}: primary finishes first`);
    assert.equal(groupDone(g), false);
    assert.equal(g.state('state.pointer.active'), true, `${input}: adjacent pores still receive pressure`);
    until(g, () => groupDone(g), `${input}: group finishes without a second gesture`);
    g.frame(2, 50);
    assert.equal(g.state('state.pointer.active'), false);
    assert.equal(g.state('state.keyboardCare.active'), false);
    if (input === 'touch') g.touch('touchend', [], fingers);
    else key(g, ' ', 'keyup');
    assertGroupAccounting(g);
  }
});

test('touch cancellation, Escape and focus loss stop pressure on every member of an unfinished group', async t => {
  for (const input of ['touch', 'keyboard', 'mouse']) {
    const g = await game(t), p = board(g);
    const fingers = input === 'touch' ? beginTouch(g, p) : null;
    if (input === 'keyboard') beginKeyboard(g, p);
    if (input === 'mouse') beginMouse(g, p);
    g.frame(4, 50);
    assert.ok(g.state('state.pimples[1].pressure') > 0, `${input}: a neighboring pore was actually receiving pressure`);
    if (input === 'touch') g.touch('touchcancel', [], fingers);
    else if (input === 'keyboard') key(g, 'Escape');
    else g.w.dispatchEvent(new g.w.Event('blur'));
    assert.equal(g.state('state.pointer.active'), false);
    assert.equal(g.state('state.pointer.lockedPimple'), null);
    const extracted = plain(g.state('state.pimples.map(p=>({id:p.id,state:p.state,extrudeProgress:p.extrudeProgress}))'));
    g.frame(80, 50);
    assert.deepEqual(plain(g.state('state.pimples.map(p=>({id:p.id,state:p.state,extrudeProgress:p.extrudeProgress}))')), extracted,
      `${input}: no member continues extracting after cancellation`);
    assert.equal(g.state('Object.keys(state.collectionLedger).length'), 0);
  }
});

test('reload preserves an interrupted group and collecting its individual pores never duplicates gifts or trophies', async t => {
  let g = await game(t), p = board(g, { primaryAhead: true, gifts: true });
  beginMouse(g, p);
  until(g, () => g.state('state.pimples[1].state===P_STATE.EXTRUDING&&state.pimples[1].extrudeProgress>.4'),
    'neighbors make visible extraction progress before the gesture is interrupted');
  g.mouse(g.w, 'mouseup', p.x + 28, p.y);
  assert.equal(p.state, 3);
  assert.equal(groupDone(g), false);
  const run = g.state('state.runId');
  const progress = plain(g.state('state.pimples.slice(0,3).map(p=>({id:p.id,state:p.state,extrudeProgress:p.extrudeProgress,giftId:p.giftId}))'));
  const score = g.state('state.score');
  g.evaluate('saveCurrentSession(true);');
  const storage = g.storage();
  g.close();
  g = await game(t, { storage, seed: 17 });
  assert.equal(g.state('state.runId'), run);
  assert.equal(g.state('state.pointer.active'), false);
  assert.equal(g.state('state.score'), score);
  assert.deepEqual(plain(g.state('state.pimples.slice(0,3).map(p=>({id:p.id,state:p.state,extrudeProgress:p.extrudeProgress,giftId:p.giftId}))')), progress);
  assert.deepEqual(plain(g.state('Object.keys(state.collectionLedger)')), ['blackhead:1']);

  // Finish each exposed neighbor with ordinary keyboard tweezers; the first
  // pore is already a skin collectible and is gathered with the real swab.
  for (const id of [2, 3]) {
    select(g, id); key(g, '4'); key(g, ' '); g.frame(80, 50); key(g, ' ', 'keyup');
    assert.ok(g.state(`state.pimples.find(p=>p.id===${id}).state>=P_STATE.HEALING`));
  }
  select(g, 1); key(g, '5'); key(g, ' '); g.frame(80, 50); key(g, ' ', 'keyup');
  g.frame(40, 50);
  assert.equal(g.state('state.trophiesPlucked'), 3);
  assert.equal(g.state('state.trophyTrayItems.length'), 3);
  assert.deepEqual(plain(g.state('state.discoveredGifts')).sort(), ['food_honey_toast', 'food_strawberry_cake', 'mask_pearl']);
  const earnedScore = g.state('state.score');
  for (const id of GROUP_IDS) {
    select(g, id); key(g, '5'); key(g, ' '); g.frame(20, 50); key(g, ' ', 'keyup');
  }
  assert.equal(g.state('state.score'), earnedScore);
  assert.equal(g.state('state.trophiesPlucked'), 3);
  assert.equal(g.state('state.discoveredGifts.length'), 3);
  g.evaluate('saveCurrentSession(true);');
  const collected = g.storage(); g.close();
  g = await game(t, { storage: collected, seed: 29 });
  g.frame(40, 50);
  assert.equal(g.state('state.trophiesPlucked'), 3);
  assert.equal(g.state('state.trophyTrayItems.length'), 3);
  assert.equal(g.state('state.score'), earnedScore);
  assert.equal(g.state('state.discoveredGifts.length'), 3);
});

test('generated phone and landscape boards keep substantial pores in reachable groups and resize deterministically', async t => {
  const sizes = [[296, 230], [390, 550], [666, 197]];
  const recipes = [{ blackhead: 6, whitehead: 2, cyst: 0 }, { blackhead: 12, whitehead: 0, cyst: 0 }];
  let boards = 0, largerGroups = 0;
  for (const [width, height] of sizes) {
    const g = await game(t, { width, height });
    for (const seed of [7, 1901, 83015]) for (const recipe of recipes) {
      // Fix only the recipe and RNG; retain production variant generation,
      // size ranges, placement, neighbor discovery and resize behavior.
      g.evaluate(`(() => {
        let seed = ${seed};
        Math.random = () => ((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
        const planner = chooseAdventurePlan;
        chooseAdventurePlan = () => ({version:1,region:'nose_cheek',pace:'busy',recipe:${JSON.stringify(recipe)}});
        try {wardrobeProgress.level=6;generateLevel(0);} finally {chooseAdventurePlan=planner;}
      })()`);
      const context = `${width}×${height}, seed ${seed}, ${Object.values(recipe).reduce((a,b)=>a+b,0)} pores`;
      const pores = plain(g.state('state.pimples.map(p=>({id:p.id,x:p.x,y:p.y,radius:p.radius,type:p.type,shared:Boolean(p.sharedPore),wormTotalLen:p.wormTotalLen}))'));
      for (const p of pores) {
        assert.ok(p.x-p.radius>=0 && p.x+p.radius<=width && p.y-p.radius>=0 && p.y+p.radius<=height,
          `${context}: pore ${p.id} stays inside the treatment area`);
        assert.ok(!(p.x+p.radius>width-104 && p.y-p.radius<94), `${context}: the tray stays clear`);
        for (const q of pores.filter(q=>q.id>p.id)) {
          assert.ok(Math.hypot(q.x-p.x,q.y-p.y)>=p.radius+q.radius, `${context}: separate openings cannot overlap`);
        }
        if (p.type === 'blackhead') {
          assert.ok(p.radius>=14, `${context}: blackhead openings retain at least a 28px footprint`);
          assert.ok(p.wormTotalLen>=34, `${context}: the smallest new plug is no longer a tiny fragment`);
        }
      }
      const black = pores.filter(p=>p.type==='blackhead'&&!p.shared);
      const nearest = Math.min(...black.flatMap((p,index)=>black.slice(index+1).map(q=>Math.hypot(q.x-p.x,q.y-p.y))));
      assert.ok(nearest<=65, `${context}: neighboring blackheads form a compact patch`);
      const groupSizes = plain(g.state("state.pimples.filter(p=>p.type==='blackhead'&&!p.sharedPore).map(p=>squeezeTargetsFor(p).length)"));
      assert.ok(Math.max(...groupSizes)>=2, `${context}: generated proximity is usable by the actual squeeze tool`);
      if (Math.max(...groupSizes)>=3) largerGroups++;
      boards++;
      assert.ok(g.state("state.pimples.filter(p=>p.type==='blackhead').every(p=>getBlackheadRenderData(p,1).thickness>=2.9)"),
        `${context}: even bundle strands keep a substantial visible body`);

      const geometry = plain(g.state('state.pimples.map(p=>({id:p.id,x:p.x,y:p.y,radius:p.radius}))'));
      const alternate = sizes.find(size=>size[0]!==width);
      g.resize(...alternate); g.resize(width,height);
      const restored = plain(g.state('state.pimples.map(p=>({id:p.id,x:p.x,y:p.y,radius:p.radius}))'));
      for (const p of restored) {
        const previous = geometry.find(q=>q.id===p.id);
        for (const field of ['x','y','radius']) {
          assert.ok(Math.abs(p[field]-previous[field])<1e-9, `${context}: resize must not drift ${field}`);
        }
      }
    }
  }
  assert.ok(largerGroups>=boards*2/3, 'three-or-four-pore squeezes are common across the generated boards');
});
