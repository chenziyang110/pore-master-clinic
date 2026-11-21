const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('./harness.cjs');
const { setupRound } = require('./round-fixture.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const plain = value => JSON.parse(JSON.stringify(value));

async function game(t, options = {}) {
  const g = await createGame({ seed: 94710, width: 390, height: 550, ...options });
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  // Keep production input, physics, drawing entry points and persistence; only
  // skip painting every intermediate frame in these interaction tests.
  g.evaluate('renderScene = () => {};');
  return g;
}

function sequence(g, { type = 'blackhead', count = 3, large = false, gift = null, client = null } = {}) {
  setupRound(g, {
    level: 7,
    recipe: { blackhead: type === 'blackhead' ? 1 : 0, whitehead: type === 'whitehead' ? 1 : 0, cyst: 0 },
    setup: `
      const p=state.pimples[0];
      p.poreSequence={count:${count},index:0};p.steamed=1;p.targetAngle=0;
      p.blackheadSize=${JSON.stringify(large && type === 'blackhead' ? 'giant' : 'normal')};
      p.whiteheadSize=${JSON.stringify(large && type === 'whitehead' ? 'large' : 'normal')};
      p.giftId=${JSON.stringify(gift)};
      state.practiceGuide.active=false;
      ${client ? `state.clientIndex=CLIENTS.findIndex(item=>item.id===${JSON.stringify(client)});` : ''}
    `
  });
  return g.state('state.pimples[0]');
}

function key(g, value, type = 'keydown', repeat = false) {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent(type,
    { key: value, bubbles: true, cancelable: true, repeat }));
}

function select(g, id) {
  g.d.getElementById('skin-canvas').focus();
  for (let step = 0; step < 80; step++) {
    const current = g.state('currentKeyboardTarget()');
    if (current?.kind === 'pimple' && current.item.id === id) return;
    key(g, 'ArrowRight');
  }
  throw new Error(`Could not select pore ${id}`);
}

function beginSqueeze(g, p, input = 'mouse') {
  if (input === 'keyboard') {
    select(g, p.id); key(g, '3'); key(g, ' ');
    return { end() { key(g, ' ', 'keyup'); } };
  }
  g.click('tool-squeeze');
  if (input === 'touch') {
    const at = half => [
      { identifier: 11, clientX: p.x-half, clientY: p.y },
      { identifier: 22, clientX: p.x+half, clientY: p.y }
    ];
    const fingers = at(38);
    g.touch('touchstart', at(48), at(48));
    g.touch('touchmove', fingers, fingers);
    return { fingers, end() { g.touch('touchend', [], fingers); } };
  }
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  g.mouse(g.w, 'mousemove', p.x+28, p.y);
  return { end() { g.mouse(g.w, 'mouseup', p.x+28, p.y); } };
}

function until(g, predicate, message) {
  let frames = 0;
  while (!predicate() && frames++ < 240) g.frame(1, 50);
  assert.ok(frames < 240, message);
}

function exposeWhitehead(g, p) {
  if (p.type !== 'whitehead' || p.state === 2) return;
  const gesture = beginSqueeze(g, p);
  until(g, () => p.state === 2, 'gentle pressure exposes the first white core');
  gesture.end();
  assert.equal(p.poreSequence?.index || 0, 0);
}

function pull(g, p, settle = true) {
  exposeWhitehead(g, p);
  const origin = plain(g.state(`getPimpleMouths(state.pimples.find(p=>p.id===${p.id}))`));
  g.click('tool-tweezers');
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  assert.equal(g.state('state.tweezers.clampedPimple?.id'), p.id,
    `a new real press can grab ${p.type} core ${(p.poreSequence?.index || 0)+1}/${p.poreSequence?.count || 1}, state ${p.state}`);
  for (let step = 1; step <= 16; step++) {
    g.mouse(g.w, 'mousemove', p.x+step*2, p.y);
    g.frame();
    assert.deepEqual(plain(g.state(`getPimpleMouths(state.pimples.find(p=>p.id===${p.id}))`)), origin,
      'successive cores keep the original pore mouth fixed throughout pulling');
  }
  g.mouse(g.w, 'mouseup', p.x+32, p.y);
  if (settle) g.frame(40, 50);
}

function wipe(g, p) {
  select(g, p.id); key(g, '5'); key(g, ' '); g.frame(60, 50); key(g, ' ', 'keyup');
}

function ledgerKeys(g) {
  return plain(g.state('Object.keys(state.collectionLedger)')).sort();
}

function coreKeys(type, id, count) {
  const kind = type === 'blackhead' ? 'blackhead' : 'seed';
  return Array.from({ length: count }, (_, index) => `${kind}:${id}${index ? ':core:'+(index+1) : ''}`).sort();
}

test('unopened repeated-content pores look and describe themselves like one ordinary visible pore', async t => {
  const g = await game(t);
  for (const type of ['blackhead', 'whitehead']) for (const count of [2, 4]) {
    sequence(g, { type, count });
    const comparison = plain(g.evaluate(`(() => {
      const p=state.pimples[0],saved=p.poreSequence;
      const paint=()=>{
        ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.setTransform(state.dpr,0,0,state.dpr,0,0);renderPimple(p,false,true);ctx.restore();
        return new Uint8ClampedArray(ctx.getImageData(0,0,canvas.width,canvas.height).data);
      };
      const describe=()=>({keyboard:keyboardTargetDescription({kind:'pimple',item:p}),
        hints:['steam','needle','squeeze','tweezers'].map(tool=>toolGuidanceFor(tool,{kind:'pimple',item:p}))});
      const repeated=paint(),repeatedCopy=describe();p.poreSequence=null;
      const ordinary=paint(),ordinaryCopy=describe();p.poreSequence=saved;
      return {identical:repeated.every((value,index)=>value===ordinary[index]),repeatedCopy,ordinaryCopy};
    })()`));
    assert.equal(comparison.identical, true, `${type}: hidden contents cannot multiply the visible surface`);
    assert.deepEqual(comparison.repeatedCopy, comparison.ordinaryCopy,
      `${type}: initial tool hints and accessible descriptions do not reveal the future count`);
    g.evaluate("state.clientIndex=CLIENTS.findIndex(client=>client.id==='foodie_vip');");
    assert.doesNotMatch(g.state('evaluateCareGoal().progress'), /\/\s*[234]\b|[234]\s*(颗|根|个)/,
      'the goal counter also keeps undiscovered internal quantities private');
  }
});

test('mouse, keyboard and touch holds extract only one core and require a fresh gesture for the next', async t => {
  for (const type of ['blackhead', 'whitehead']) for (const input of ['mouse', 'keyboard', 'touch']) {
    const g = await game(t), p = sequence(g, { type, count: 4 });
    const origin = { x: p.x, y: p.y, radius: p.radius };
    const gesture = beginSqueeze(g, p, input);
    until(g, () => p.poreSequence.index === 1, `${type}/${input}: the first core leaves the pore`);
    assert.equal(p.type, type, 'a repeated-content pore keeps its original type');
    assert.equal(p.state, 2, 'the next core is exposed without marking the pore clean');
    assert.deepEqual({ x: p.x, y: p.y, radius: p.radius }, origin);
    assert.equal(type === 'blackhead' ? p.extrudeProgress : p.pusRemaining, type === 'blackhead' ? .12 : .36);
    const score = g.state('state.score'), serial = g.state('state.actionSerial');
    const remaining = { progress: p.extrudeProgress, pus: p.pusRemaining };
    if (input === 'keyboard') key(g, ' ', 'keydown', true);
    if (input === 'mouse') g.mouse(g.w, 'mousemove', p.x+26, p.y);
    if (input === 'touch') {
      // A newly added finger is not a new squeeze while the original contact
      // remains down, even if the first extraction released the logical tool.
      const extra = { identifier: 33, clientX: p.x, clientY: p.y+30 };
      gesture.fingers.push(extra);
      g.touch('touchstart', gesture.fingers, [extra]);
      g.touch('touchmove', gesture.fingers, [extra]);
      const lifted=gesture.fingers.splice(1,1)[0];
      g.touch('touchend',gesture.fingers,[lifted]);
      const replacement={identifier:44,clientX:p.x+38,clientY:p.y};
      gesture.fingers.push(replacement);
      g.touch('touchstart',gesture.fingers,[replacement]);
      g.touch('touchmove',gesture.fingers,[replacement]);
    }
    g.frame(160, 50);
    assert.equal(g.state('state.actionSerial'), serial, `${input}: continued contact cannot manufacture a new action`);
    assert.equal(p.poreSequence.index, 1);
    assert.deepEqual({ progress: p.extrudeProgress, pus: p.pusRemaining }, remaining,
      `${type}/${input}: the waiting core does not drain under the old hold`);
    assert.equal(g.state('state.score'), score);
    assert.deepEqual(ledgerKeys(g), coreKeys(type, p.id, 1));
    assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'), 1);
    gesture.end();

    const next = beginSqueeze(g, p, input);
    assert.ok(g.state('state.actionSerial') > serial);
    until(g, () => p.poreSequence.index === 2, `${type}/${input}: a new gesture releases the next core`);
    next.end();g.frame(40, 50);
    assert.deepEqual(ledgerKeys(g), coreKeys(type, p.id, 2));
    assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'), 2);
    assert.equal(g.state('state.damage'), 0);
  }
});

test('two, three and four same-type cores are separately plucked and collected exactly once at one fixed opening', async t => {
  for (const type of ['blackhead', 'whitehead']) for (const count of [2, 3, 4]) {
    const g = await game(t), p = sequence(g, { type, count, large: count === 4 });
    const origin = { x: p.x, y: p.y, radius: p.radius };
    let score = g.state('state.score');
    for (let core = 1; core <= count; core++) {
      pull(g, p);
      assert.equal(p.type, type);
      assert.deepEqual({ x: p.x, y: p.y, radius: p.radius }, origin);
      assert.equal(p.poreSequence.index, Math.min(core, count-1));
      assert.deepEqual(ledgerKeys(g), coreKeys(type, p.id, core));
      assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'), core);
      assert.equal(g.state('state.trophyTrayItems.length'), core);
      assert.ok(g.state('state.score') > score, 'every distinct extraction earns its own ordinary credit');
      score = g.state('state.score');
      if (core < count) {
        assert.equal(p.state, 2);
        assert.equal(g.d.getElementById('btn-ice-quick').classList.contains('show'), false,
          'a partially emptied pore cannot unlock settlement');
      }
    }
    assert.equal(g.state(`state.surfaceResidues.some(r=>r.pimpleId===${p.id}&&['worm','core_seed'].includes(r.kind))`), false,
      'automatic collection does not leave duplicate physical cores on the skin');
    if (type === 'blackhead') assert.ok(p.state >= 4, 'the last blackhead leaves a clean opening');
    else {
      assert.equal(p.state, 3, 'the last white core still leaves the normal surface cleanup');
      wipe(g, p);assert.ok(p.state >= 4);
    }
    const earned = g.state('state.score');
    wipe(g, p);g.frame(40, 50);
    assert.equal(g.state('state.score'), earned);
    assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'), count);
    assert.ok(g.state('Object.values(state.collectionLedger).every(item=>item.location===\'tray\'&&item.rewards.extract===true)'));
  }
});

test('legacy blackhead-then-whitehead shared pores also wait for a new squeeze between their original two stages', async t => {
  const g = await game(t);
  setupRound(g, { level: 7, recipe: { blackhead: 1, whitehead: 0, cyst: 0 }, setup: `
    const p=state.pimples[0];p.sharedPore={mode:'sequential',phase:'blackhead'};
    p.poreSequence=null;p.steamed=1;p.targetAngle=0;state.practiceGuide.active=false;
  ` });
  const p = g.state('state.pimples[0]'), mouth = plain(g.state('getPimpleMouths(state.pimples[0])'));
  const first = beginSqueeze(g, p, 'keyboard');
  until(g, () => p.sharedPore.phase === 'whitehead', 'the old shared black plug exposes its white core');
  assert.equal(p.type, 'whitehead');assert.equal(p.poreSequence, null);assert.equal(p.state, 2);
  const remaining = p.pusRemaining;
  g.frame(160, 50);
  assert.equal(p.pusRemaining, remaining);
  assert.deepEqual(ledgerKeys(g), [`blackhead:${p.id}`]);
  assert.deepEqual(plain(g.state('getPimpleMouths(state.pimples[0])')), mouth);
  first.end();
  const second = beginSqueeze(g, p, 'keyboard');
  until(g, () => p.sharedPore.phase === 'done', 'a fresh action still completes the old shared whitehead');
  second.end();wipe(g, p);g.frame(40, 50);
  assert.deepEqual(ledgerKeys(g), [`blackhead:${p.id}`, `seed:${p.id}`]);
  assert.equal(g.state('state.trophiesPlucked'), 1);
  assert.equal(g.state('state.coreSeedsCollected'), 1);
});

test('an in-flight first core and a partly treated later core survive reload without rerolling or duplicating collection', async t => {
  for (const type of ['blackhead', 'whitehead']) {
    let g = await game(t), p = sequence(g, { type, count: 4, gift: 'food_strawberry_cake' });
    const run = g.state('state.runId'), origin = { x: p.x, y: p.y, radius: p.radius };
    pull(g, p, false);
    assert.equal(p.poreSequence.index, 1);
    assert.equal(g.state('state.flyingTrophies.length'), 1);
    g.evaluate('saveCurrentSession(true);');
    let stored = g.storage();g.close();
    g = await game(t, { storage: stored, seed: 73 });p = g.state('state.pimples[0]');
    assert.equal(g.state('state.runId'), run);
    assert.deepEqual(plain(p.poreSequence), { count: 4, index: 1 });
    assert.deepEqual({ x: p.x, y: p.y, radius: p.radius }, origin);
    assert.equal(p.giftId, 'food_strawberry_cake');
    assert.equal(g.state('state.pointer.active'), false);
    g.frame(40, 50);
    assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'), 1);
    assert.deepEqual(ledgerKeys(g), coreKeys(type, p.id, 1));

    const second = beginSqueeze(g, p);
    until(g, () => type === 'blackhead' ? p.extrudeProgress > .32 : p.pusRemaining < .25,
      'a fresh action after reload can partially treat the next core');
    second.end();
    assert.equal(p.poreSequence.index, 1);
    const partial = { progress: p.extrudeProgress, pus: p.pusRemaining, score: g.state('state.score') };
    g.evaluate('saveCurrentSession(true);');stored = g.storage();g.close();
    g = await game(t, { storage: stored, seed: 19 });p = g.state('state.pimples[0]');
    assert.deepEqual(plain(p.poreSequence), { count: 4, index: 1 });
    assert.deepEqual({ progress: p.extrudeProgress, pus: p.pusRemaining, score: g.state('state.score') }, partial);
    for (let core = 2; core <= 4; core++) pull(g, p);
    if (type === 'whitehead') wipe(g, p);
    assert.deepEqual(ledgerKeys(g), coreKeys(type, p.id, 4));
    assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'), 4);
    assert.deepEqual(plain(g.state('state.discoveredGifts')), ['food_strawberry_cake']);
  }
});

test('invalid sequence parameters, incompatible variants and missing or future core history are rejected before hydration', async t => {
  const g = await game(t), p = sequence(g, { count: 3 });
  const fresh = JSON.parse(g.w.localStorage.getItem(PROFILE)).session;
  const run = g.state('state.runId');
  const reject = (source, mutate, message) => {
    const broken = plain(source);mutate(broken.data);
    assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(broken))})`), false, message);
    assert.equal(g.state('state.runId'), run, `${message}: rejection leaves the playable run intact`);
  };
  for (const bad of [{count:1,index:0},{count:5,index:0},{count:2.5,index:0},{count:3,index:-1},
    {count:3,index:3},{count:3,index:.5},{count:3},{index:0},'3',[]]) {
    reject(fresh, data => { data.pimples[0].poreSequence = bad; }, `illegal sequence ${JSON.stringify(bad)}`);
  }
  for (const [message, mutate] of [
    ['linked openings cannot also have repeated cores', p => {p.linkedPore=true;}],
    ['shared mixed contents cannot also have repeated cores', p => {p.sharedPore={mode:'together',phase:'blackhead'};}],
    ['simultaneous bundles cannot also have repeated cores', p => {p.blackheadCount=2;p.blackheadLengths=[1,1];}],
    ['deep targets do not have this sequence variant', p => {p.type='cyst';}]
  ]) reject(fresh, data => mutate(data.pimples[0]), message);

  pull(g, p, false);
  g.evaluate('saveCurrentSession(true);');
  const middle = JSON.parse(g.w.localStorage.getItem(PROFILE)).session;
  const first = `blackhead:${p.id}`;
  assert.equal(middle.data.collectionLedger[first].location,'flight');
  assert.equal(middle.data.flyingTrophies.length,1,'the corruption fixture contains an actual collected core in flight');
  reject(middle, data => {
    delete data.collectionLedger[first];
    data.flyingTrophies=data.flyingTrophies.filter(item=>item.collectionId!==first);
    data.trophyTrayItems=data.trophyTrayItems.filter(item=>item.collectionId!==first);
    data.surfaceResidues=data.surfaceResidues.filter(item=>item.collectionId!==first);
    data.trophiesPlucked=0;
  }, 'advancing the pore without the prior core ledger is invalid even when all dangling references are removed');
  reject(middle, data => {
    data.collectionLedger[`${first}:core:3`]=plain(data.collectionLedger[first]);
  }, 'a not-yet-extracted future core cannot already appear in the ledger');
  reject(middle, data => {data.pimples[0].poreSequence.index=2;}, 'skipping an unrecorded middle core is invalid');
  reject(middle, data => {data.pimples[0].poreSequence.count=4;}, 'the saved initial and current contents cannot disagree');
  reject(middle, data => {data.initialPimples[0].poreSequence.index=1;}, 'the initial snapshot cannot claim a core was already removed');
  reject(middle, data => {data.flyingTrophies=data.flyingTrophies.filter(item=>item.collectionId!==first);},
    'a flight ledger without its physical in-flight core cannot silently lose a collection');
  reject(middle, data => {
    const current=`${first}:core:2`;
    data.collectionLedger[current]={...plain(data.collectionLedger[first]),sequenceIndex:1,rewards:{}};
    data.flyingTrophies.push({...plain(data.flyingTrophies[0]),collectionId:current});
  }, 'even a legal current ordinal cannot fly before its extraction is recorded');
  reject(middle, data => {
    const wrong=`seed:${p.id}`;
    data.collectionLedger[wrong]={...plain(data.collectionLedger[first]),kind:'seed',sourceType:'whitehead'};
    data.flyingTrophies.push({...plain(data.flyingTrophies[0]),collectionId:wrong,kind:'seed'});
  }, 'a black-only sequence cannot forge an additional white-core base ID');
  reject(middle, data => {delete data.pimples[0].poreSequence;},
    'dropping the current sequence cannot erase the initial pore contents');
  assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(middle))})`), true,
    'the unmodified mid-sequence save remains valid after all rejection checks');
});

test('generated sequences are common in both pore types, varied in length and remain exclusive with other content variants', async t => {
  const g = await game(t);
  const variantsFor = g.evaluate('adventurePoreVariants');
  const types = [...Array(6).fill('blackhead'), ...Array(4).fill('whitehead'), 'cyst'];
  let seed = 72891;
  const random = () => ((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const counts = {blackhead:0,whitehead:0,two:0,three:0,four:0,light:0,ordinary:0};
  for (const level of [1,2]) for (let sample=0;sample<12;sample++) {
    assert.equal(variantsFor(types,level,random).some(p=>p.poreSequence),false,'introductory care keeps its simple contents');
  }
  for (let sample=0;sample<240;sample++) {
    const variants = variantsFor(types,7,random);
    assert.equal(variants.length,types.length,'internal cores do not add external care targets');
    assert.ok(variants.filter(p=>p.poreSequence).length>=5,
      'a full mixed board offers at least five separate hidden-reveal opportunities');
    assert.ok(variants.some((p,index)=>types[index]==='blackhead'&&!p.poreSequence),
      'full boards retain another blackhead opening alongside sequential surprises');
    for (let index=0;index<variants.length;index++) {
      const p = variants[index], sequence = p.poreSequence;
      if (!sequence) {counts.ordinary++;continue;}
      assert.ok(['blackhead','whitehead'].includes(types[index]));
      assert.ok(Number.isInteger(sequence.count)&&sequence.count>=2&&sequence.count<=4);
      assert.equal(sequence.index,0);
      assert.equal(p.blackheadCount,1);
      assert.equal(Boolean(p.linkedPore),false);
      assert.equal(Boolean(p.sharedPore),false);
      counts[types[index]]++;
      counts[{2:'two',3:'three',4:'four'}[sequence.count]]++;
    }
    for (const lightTypes of [['blackhead','blackhead','whitehead'],['blackhead','blackhead','whitehead','whitehead']]) {
      const sequences=variantsFor(lightTypes,7,random).filter(p=>p.poreSequence);
      assert.ok(sequences.length<=1,'a light board has at most one hidden sequence');
      assert.ok(sequences.every(p=>p.poreSequence.count===2),'light boards use only two-core surprises');
      counts.light+=sequences.length;
    }
  }
  assert.ok(counts.blackhead>120&&counts.whitehead>120,'both types repeatedly produce the variant');
  assert.ok(counts.whitehead/4>counts.blackhead/6,'whitehead opportunities carry the variant more often');
  assert.ok(counts.two>counts.three&&counts.two>counts.four,'two-core discoveries remain the usual length');
  assert.ok(counts.three>0&&counts.four>0&&counts.light>0&&counts.ordinary>0,'longer surprises and ordinary pores remain reachable');
  for (const blackCount of [2,3]) for (let sample=0;sample<12;sample++) {
    const mixed=[...Array(blackCount).fill('blackhead'),...Array(4).fill('whitehead')];
    const variants=variantsFor(mixed,7,random);
    const black=variants.slice(0,blackCount),white=variants.slice(blackCount);
    assert.ok(black.some(p=>p.poreSequence),'even a whitehead-heavy board has a hidden blackhead follow-up');
    assert.ok(black.some(p=>!p.poreSequence),'a small blackhead group keeps an alternative extraction');
    assert.ok(white.filter(p=>p.poreSequence).length>=3,'whitehead-heavy boards regularly offer multiple separate reveals');
  }
  const early=variantsFor(types,3,random);
  assert.ok(early.slice(0,6).filter(p=>p.poreSequence).length<=2
    &&early.slice(6,10).filter(p=>p.poreSequence).length<=2,
    'the first surprise level introduces at most two sequences of each kind');
});

test('all hidden cores count toward care goals while one pore grants its bound food only once at settlement', async t => {
  for (const client of ['coder','foodie_vip','strawberry_nose']) {
    const g = await game(t), p = sequence(g, {count:3,gift:'food_strawberry_cake',client});
    const run = g.state('state.runId');
    pull(g,p);
    assert.equal(g.evaluate(`(() => {state.settled=true;try{return evaluateCareGoal().met;}finally{state.settled=false;}})()`),false,
      `${client}: one extracted core is not the complete hidden contents`);
    assert.doesNotMatch(g.state('evaluateCareGoal().progress'), /\/\s*3\b/,'the in-progress goal does not disclose the remaining total');
    assert.equal(g.state('wardrobeProgress.pantry.food_strawberry_cake||0'),0);
    pull(g,p);pull(g,p);
    assert.equal(g.state('state.trophiesPlucked'),3);
    assert.deepEqual(plain(g.state('state.discoveredGifts')),['food_strawberry_cake']);
    assert.equal(g.state('wardrobeProgress.pantry.food_strawberry_cake||0'),0,'discovery still waits for actual round completion');
    g.click('btn-ice-quick');g.frame(65,50);
    assert.equal(g.state('state.settled'),true);
    const record=plain(g.state('careRecords.history[0]'));
    assert.equal(record.runId,run);assert.equal(record.collected,3);assert.equal(record.goal.met,true,`${client}: all three real extractions satisfy the goal`);
    assert.deepEqual(record.foodGifts,['food_strawberry_cake']);
    assert.equal(g.state('wardrobeProgress.pantry.food_strawberry_cake'),1);
    const earned=g.state('state.coins'),level=g.state('wardrobeProgress.level');
    g.evaluate('openSettlementModal();openSettlementModal();');
    assert.equal(g.state('careRecords.history.filter(record=>record.runId===state.runId).length'),1);
    assert.equal(g.state('state.coins'),earned);
    assert.equal(g.state('wardrobeProgress.level'),level);
    assert.equal(g.state('wardrobeProgress.pantry.food_strawberry_cake'),1,'reopening cannot award one gift per hidden core');
  }
});
