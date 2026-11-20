const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const DEFAULTS = {hair:'none',dress:'patched',skin:'natural',lashes:'natural',eyes:'natural',
  lips:'natural',hairstyle:'original',shoes:'worn',bracelet:'none',necklace:'none'};
const ITEMS = {bow_rose:'hair',clip_star:'hair',band_lilac:'hair',dress_sky:'dress',dress_peach:'dress',dress_lilac:'dress',
  mask_pearl:'skin',mascara_cocoa:'lashes',contacts_hazel:'eyes',contacts_ocean:'eyes',lipstick_rose:'lips',lipstick_peach:'lips',
  hairstyle_bob:'hairstyle',hairstyle_twintails:'hairstyle',shoes_rose:'shoes',shoes_maryjane:'shoes',
  bracelet_pearl:'bracelet',necklace_star:'necklace'};

async function game(t, options = {}) {
  const g = await createGame({seed:11019, ...options});
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  return g;
}

function startLevel(g, level, gifts = []) {
  g.evaluate(`document.querySelectorAll('.modal-backdrop.open').forEach(m=>m.classList.remove('open'));
    wardrobeProgress.level=${level};state.runLevel=${level};generateLevel(0);
    state.paused=false;selectTool('steam');`);
  // Reward-accounting tests bind a known outcome to real care points. The
  // random selection and generateLevel binding have their own tests below.
  g.evaluate(`(() => {
    const gifts=${JSON.stringify(gifts)};
    state.discoveredGifts=[];
    for(const p of state.pimples)p.giftId=null;
    gifts.forEach((id,index)=>{
      if(!wardrobeRewardPool(state.runLevel).includes(id)||!state.pimples[index])throw new Error('Invalid gift fixture');
      state.pimples[index].giftId=id;
    });
    for(const p of state.initialPimples)p.giftId=state.pimples.find(item=>item.id===p.id).giftId;
    saveCurrentSession(true);
  })()`);
  g.frame();
}

function discover(g, ids = null) {
  g.evaluate(`state.pimples.forEach(p=>{if(p.giftId&&(${JSON.stringify(ids)}===null||${JSON.stringify(ids)}.includes(p.giftId))){
    if(p.sharedPore){p.sharedPore.phase='done';if(p.sharedPore.mode==='sequential'){p.type='whitehead';p.cfg=CONFIG.TYPES.WHITEHEAD;}}
    p.state=P_STATE.OOZING;revealWardrobeFind(p);}});saveCurrentSession(true);`);
}

function finish(g) {
  // Extraction state is an explicit fixture. The ordinary ice button,
  // settlement, idempotence guard and single profile write award the outfit.
  g.evaluate(`state.pimples.forEach(p=>{
    if(p.sharedPore){p.sharedPore.phase='done';if(p.sharedPore.mode==='sequential'){p.type='whitehead';p.cfg=CONFIG.TYPES.WHITEHEAD;}}
    p.state=P_STATE.HEALED;p.healProgress=1;
  });updateHUD();`);
  g.click('btn-ice-quick');
  g.frame(65);
  assert.equal(g.state('state.settled'), true);
  assert.equal(g.d.getElementById('result-modal').classList.contains('open'), true);
}

function assertOutfitLayers(g, expected) {
  for(const portrait of ['home-girl','wardrobe-girl']) for(const [slot,id] of Object.entries(expected)) {
    const layers=[...g.d.getElementById(portrait).querySelectorAll(`[data-dressup-slot="${slot}"]`)];
    assert.ok(layers.length, `${portrait} has a ${slot} layer`);
    assert.ok(layers.every(layer=>layer.dataset.equipped===id), `${portrait} renders the selected ${slot}`);
  }
}

test('home introduces the girl, pauses care and enters a genuinely simple first level', async t => {
  const g = await game(t, {stayHome:true});
  const enter = g.d.getElementById('btn-start-adventure');
  const home = enter.closest('.modal-backdrop');
  assert.ok(home.classList.contains('open'));
  assert.match(home.textContent, /装扮/);
  assert.ok(home.querySelector('svg'), 'the girl is rendered on the home screen');
  assert.equal(g.state('wardrobeProgress.equipped.dress'), 'patched');
  assert.equal(g.state('state.paused'), true);
  assert.equal(g.state('canRenderCare()'), false);
  const run = g.state('state.runId');
  g.frame(30);
  assert.equal(g.state('state.runId'), run);
  g.click('btn-start-adventure');
  await tick();
  assert.equal(home.classList.contains('open'), false);
  assert.equal(g.state('state.paused'), false);
  assert.equal(g.state('state.runLevel'), 1);
  assert.equal(g.state('state.pimples.length'), 3);
  assert.equal(g.state('state.pimples.every(p=>p.type==="blackhead"&&!p.linkedPore&&!p.sharedPore&&!p.giftId)'), true);
  assert.equal(g.d.activeElement.id,'current-level','entering from home announces the level without selecting a keyboard target');
  assert.equal(g.d.activeElement.getAttribute('tabindex'),'-1');
  assert.equal(g.state('isKeyboardCareFocused()'),false);
  assert.equal(g.state('state.keyboardCare.visible'),false);
  assert.equal(g.state('state.runControlMode'),'pointer');
  assert.doesNotMatch(g.d.getElementById('hint-banner').textContent,/按住空格或回车/);
  // An intentional keyboard focus still opts into the normal accessible care
  // controls; the fix must not disable keyboard navigation altogether.
  g.d.getElementById('skin-canvas').focus();
  assert.equal(g.state('isKeyboardCareFocused()'),true);
  assert.equal(g.d.getElementById('keyboard-care-status').hidden,false);
});

test('early levels stay simple and random rewards can vary in count and category after level two', async t => {
  const g = await game(t);
  assert.deepEqual(plain(g.state('adventureRecipeFor(1)')), {blackhead:3,whitehead:0,cyst:0});
  assert.deepEqual(plain(g.state('adventureRecipeFor(2)')), {blackhead:4,whitehead:0,cyst:0});
  assert.deepEqual(plain(g.state('adventureRecipeFor(3)')), {blackhead:3,whitehead:1,cyst:0});
  assert.deepEqual(plain(g.state('WARDROBE_DEFAULTS')), DEFAULTS);
  assert.deepEqual(plain(g.state('Object.fromEntries(WARDROBE_ITEMS.map(item=>[item.id,item.slot]))')), ITEMS);
  for(const level of [1,2]) {
    assert.deepEqual(plain(g.state(`rollWardrobeGifts(${level},()=>{throw new Error('Early level rolled a gift');},[])`)), []);
    assert.deepEqual(plain(g.state(`wardrobeRewardPool(${level})`)), []);
  }
  const before=plain(g.state('wardrobeProgress'));
  const samples=plain(g.state(`(() => {
    let seed=771203;
    const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    return Array.from({length:512},(_,index)=>rollWardrobeGifts(3+index%8,random,[]));
  })()`));
  assert.deepEqual([...new Set(samples.map(sample=>sample.length))].sort(),[0,1,2], 'some runs have no gift and others one or two');
  for(const sample of samples) {
    assert.equal(new Set(sample).size,sample.length,'a single run never repeats a gift');
    assert.ok(sample.every(id=>Object.hasOwn(ITEMS,id)),'every random gift is a known item');
  }
  assert.deepEqual([...new Set(samples.flat().map(id=>ITEMS[id]))].sort(),Object.keys(DEFAULTS).sort(),
    'random surprises cover every dress-up category without a fixed milestone schedule');
  assert.deepEqual(plain(g.state('wardrobeProgress')),before,'rolling does not grant or equip anything');
  startLevel(g, 3);
  assert.equal(g.state('wardrobeProgress.unlocked.length'), 0, 'a hidden gift is not owned before care');
});

test('random rewards exclude owned items and stop cleanly when the collection is complete', async t => {
  const g=await game(t);
  const remaining='necklace_star';
  const samples=plain(g.state(`(() => {
    let seed=9813;
    const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    const owned=WARDROBE_ITEMS.map(item=>item.id).filter(id=>id!==${JSON.stringify(remaining)});
    return Array.from({length:64},()=>rollWardrobeGifts(4,random,owned));
  })()`));
  assert.ok(samples.some(sample=>sample.includes(remaining)), 'the final unknown item remains discoverable');
  assert.ok(samples.every(sample=>sample.length<=1&&sample.every(id=>id===remaining)), 'the remaining pool caps double drops');
  assert.deepEqual(plain(g.state('rollWardrobeGifts(8,()=>0,WARDROBE_ITEMS.map(item=>item.id))')),[]);
});

test('a new level rolls once and binds its gifts to real saved care points', async t => {
  const g=await game(t);
  g.evaluate(`window.giftRollCalls=0;window.originalGiftRoll=rollWardrobeGifts;
    rollWardrobeGifts=()=>{window.giftRollCalls++;return ['contacts_hazel','shoes_rose'];};
    wardrobeProgress.level=4;generateLevel(0);state.paused=false;saveCurrentSession(true);`);
  assert.equal(g.w.giftRollCalls,1);
  const bindings=plain(g.state('state.pimples.filter(p=>p.giftId).map(p=>({id:p.id,giftId:p.giftId}))'));
  assert.equal(bindings.length,2);
  assert.equal(new Set(bindings.map(p=>p.id)).size,2);
  assert.deepEqual(bindings.map(p=>p.giftId).sort(),['contacts_hazel','shoes_rose']);
  const saved=JSON.parse(g.w.localStorage.getItem(PROFILE));
  assert.deepEqual(saved.session.data.pimples.filter(p=>p.giftId).map(p=>({id:p.id,giftId:p.giftId})),bindings);
  g.evaluate('updateHUD();renderWardrobe();selectTool("needle");selectTool("steam");');
  g.click('btn-wardrobe');g.click('btn-close-wardrobe');g.frame(10);
  assert.equal(g.w.giftRollCalls,1,'HUD, wardrobe and animation frames do not reroll');
  assert.deepEqual(plain(g.state('state.discoveredGifts')),[]);
  assert.deepEqual(plain(g.state('wardrobeProgress.unlocked')),[]);
  g.evaluate('rollWardrobeGifts=window.originalGiftRoll;');
});

test('the wardrobe shows only owned items and leaves unknown surprises anonymous', async t => {
  const g=await game(t,{stayHome:true});
  g.click('btn-home-wardrobe');
  const collection=g.d.getElementById('wardrobe-collection');
  const coming=g.d.getElementById('wardrobe-coming-soon');
  assert.ok(collection&&coming);
  assert.equal(collection.querySelectorAll('button[data-equip]').length,0);
  assert.equal(collection.querySelectorAll('svg').length,0,'unknown items have no preview artwork');
  assert.equal(coming.hidden,false);
  assert.match(coming.textContent,/敬请期待/);
  for(const item of plain(g.state('WARDROBE_ITEMS'))) {
    assert.equal(g.d.querySelector(`#wardrobe-modal [data-equip="${item.id}"]`),null);
    assert.ok(!g.d.getElementById('wardrobe-modal').textContent.includes(item.name),`${item.id} is not previewed by name`);
  }
  assert.doesNotMatch(g.d.getElementById('wardrobe-modal').textContent,/第\s*\d+\s*关|每\s*[三五35]\s*关/);
  g.click('btn-close-wardrobe');g.click('btn-start-adventure');
  startLevel(g,4,['mask_pearl']);discover(g);finish(g);g.click('btn-open-wardrobe-result');
  const owned=[...collection.querySelectorAll('button[data-equip]')].map(button=>button.dataset.equip);
  assert.deepEqual(owned,['mask_pearl']);
  assert.equal(collection.querySelector('[data-equip="mask_pearl"]').disabled,false);
  for(const item of plain(g.state('WARDROBE_ITEMS')).filter(item=>item.id!=='mask_pearl'))
    assert.ok(!collection.textContent.includes(item.name),`unowned ${item.id} stays anonymous after the first find`);
});

test('opening and closing the wardrobe returns to its original home, game or result screen', async t => {
  const g=await game(t,{stayHome:true});
  g.click('btn-home-wardrobe');
  assert.equal(g.d.getElementById('wardrobe-modal').classList.contains('open'),true);
  assert.equal(g.state('state.paused'),true);
  g.click('btn-close-wardrobe');
  assert.equal(g.d.getElementById('home-modal').classList.contains('open'),true);
  assert.equal(g.state('state.paused'),true);
  g.click('btn-start-adventure');
  const run=g.state('state.runId');
  g.click('btn-wardrobe');g.click('btn-close-wardrobe');
  assert.equal(g.state('state.paused'),false);
  assert.equal(g.state('state.runId'),run);
  startLevel(g,3,['bow_rose']);discover(g);finish(g);
  g.click('btn-open-wardrobe-result');g.click('btn-close-wardrobe');
  assert.equal(g.d.getElementById('result-modal').classList.contains('open'),true);
  assert.equal(g.state('canRenderCare()'),false);
  assert.equal(g.state('wardrobeProgress.level'),4);
});

test('bound and discovered gifts survive reload without another random draw or early ownership', async t => {
  const g = await game(t);
  startLevel(g, 4, ['bow_rose','mask_pearl']);
  discover(g,['bow_rose']);
  discover(g,['bow_rose']);
  assert.deepEqual(plain(g.state('state.discoveredGifts')), ['bow_rose']);
  assert.equal(g.state('wardrobeProgress.unlocked.includes("bow_rose")'), false);
  const run = g.state('state.runId');
  const bindings=plain(g.state('state.pimples.map(p=>({id:p.id,giftId:p.giftId}))'));
  const stored = g.storage();
  g.close();
  const restored = await game(t, {storage:stored,seed:77651,setupWindow(w) {
    w.giftRollCalls=0;
    w.addEventListener('load',()=>w.eval(`window.originalGiftRoll=rollWardrobeGifts;
      rollWardrobeGifts=function(...args){window.giftRollCalls++;return window.originalGiftRoll(...args);};`),{once:true});
  }});
  assert.equal(restored.w.giftRollCalls,0,'restoring a saved board never draws a replacement gift');
  assert.equal(restored.state('state.runId'), run);
  assert.equal(restored.state('state.runLevel'), 4);
  assert.deepEqual(plain(restored.state('state.pimples.map(p=>({id:p.id,giftId:p.giftId}))')),bindings);
  assert.deepEqual(plain(restored.state('state.discoveredGifts')), ['bow_rose']);
  discover(restored);
  finish(restored);
  assert.deepEqual(plain(restored.state('wardrobeProgress.unlocked')).sort(), ['bow_rose','mask_pearl']);
  assert.equal(restored.state('wardrobeProgress.level'), 5);
});

test('a saved bound gift remains stable even if the wardrobe already owns that item', async t => {
  const source=await game(t);
  startLevel(source,4,['clip_star']);
  const profile=JSON.parse(source.w.localStorage.getItem(PROFILE));
  const boundId=profile.session.data.pimples.find(p=>p.giftId==='clip_star').id;
  profile.wardrobe.unlocked=['clip_star'];
  const restored=await game(t,{storage:{[PROFILE]:JSON.stringify(profile)},seed:88127});
  assert.equal(restored.state(`state.pimples.find(p=>p.id===${boundId}).giftId`),'clip_star');
  discover(restored);finish(restored);
  assert.deepEqual(plain(restored.state('wardrobeProgress.unlocked')),['clip_star']);
  assert.deepEqual(plain(restored.state('careRecords.history[0].newWardrobeGifts')),[],'an already-owned find is never granted twice');
});

test('only a real opened care point reveals a gift and launches it from that point once', async t => {
  const g=await game(t);
  startLevel(g,4,['contacts_ocean']);
  assert.equal(g.state('revealWardrobeFind({...state.pimples[0],state:P_STATE.OOZING})'),false,'a copied or unrelated object is not a care point');
  assert.equal(g.state('revealWardrobeFind(state.pimples[0])'),false,'an intact point has not revealed its contents');
  g.evaluate('state.pimples[0].state=P_STATE.OOZING;');
  assert.equal(g.state('revealWardrobeFind(state.pimples[0])'),true);
  const source=plain(g.state('({id:state.pimples[0].id,x:state.pimples[0].x/state.width,y:state.pimples[0].y/state.height})'));
  const flight=g.d.querySelector('#gift-flight-layer .gift-flight[data-item-id="contacts_ocean"]');
  assert.ok(flight,'a discovered item has its own flight element');
  assert.equal(flight.dataset.sourcePimpleId,String(source.id));
  assert.ok(Math.abs(Number(flight.dataset.sourceX)-source.x)<1e-6);
  assert.ok(Math.abs(Number(flight.dataset.sourceY)-source.y)<1e-6);
  assert.match(flight.style.left,/%$/);assert.match(flight.style.top,/%$/);
  assert.ok(Math.abs(parseFloat(flight.style.left)/100-source.x)<1e-4);
  assert.ok(Math.abs(parseFloat(flight.style.top)/100-source.y)<1e-4);
  assert.equal(g.state('revealWardrobeFind(state.pimples[0])'),false);
  assert.equal(g.d.querySelectorAll('#gift-flight-layer .gift-flight[data-item-id="contacts_ocean"]').length,1);
  assert.deepEqual(plain(g.state('state.discoveredGifts')),['contacts_ocean']);
  assert.deepEqual(plain(g.state('wardrobeProgress.unlocked')),[]);
  // Neither another copy of the same gift nor an unbound discovery entry may
  // mint a second award when the real settlement runs.
  g.evaluate(`state.pimples[1].giftId='contacts_ocean';state.pimples[1].state=P_STATE.OOZING;
    if(state.pimples[1].sharedPore)state.pimples[1].sharedPore.phase='done';
    revealWardrobeFind(state.pimples[1]);state.discoveredGifts.push('mask_pearl','not-a-real-item');`);
  finish(g);
  assert.deepEqual(plain(g.state('wardrobeProgress.unlocked')),['contacts_ocean']);
  assert.deepEqual(plain(g.state('careRecords.history[0].wardrobeGifts')),['contacts_ocean']);
});

test('reduced-motion discovery announces the same item immediately without bypassing settlement', async t => {
  const g=await game(t,{setupWindow(w) {
    w.matchMedia=query=>({matches:query.includes('prefers-reduced-motion'),media:query,onchange:null,
      addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true;}});
  }});
  startLevel(g,4,['mascara_cocoa']);discover(g);
  assert.equal(g.d.getElementById('gift-discovery').hidden,false);
  assert.ok(g.d.querySelector('#gift-flight-layer [data-item-id="mascara_cocoa"]'));
  assert.deepEqual(plain(g.state('state.discoveredGifts')),['mascara_cocoa']);
  assert.deepEqual(plain(g.state('wardrobeProgress.unlocked')),[]);
  finish(g);
  assert.deepEqual(plain(g.state('wardrobeProgress.unlocked')),['mascara_cocoa']);
});

test('settlement unlocks once, advances once and keeps the result free of ratings', async t => {
  const g = await game(t);
  startLevel(g, 3, ['bow_rose']);
  discover(g);
  finish(g);
  const run = g.state('state.runId');
  const completed = g.state('careRecords.history.length');
  const progress = plain(g.state('wardrobeProgress'));
  g.evaluate('openSettlementModal();openSettlementModal();');
  assert.deepEqual(plain(g.state('wardrobeProgress')), progress);
  assert.equal(g.state('careRecords.history.length'), completed);
  assert.equal(g.state('careRecords.history.filter(record=>record.runId===state.runId).length'), 1);
  assert.equal(g.state('wardrobeProgress.level'), 4);
  assert.ok(g.d.getElementById('result-modal').textContent.includes('运气超棒'));
  for (const id of ['result-rank','res-score','res-quality','res-quality-reason']) {
    const element = g.d.getElementById(id);
    assert.ok(!element || element.closest('[hidden]'), `${id} cannot appear in the result or accessibility tree`);
  }
  assert.equal(g.state('state.runId'), run);
  g.click('btn-next-face');
  assert.equal(g.state('state.runLevel'), 4);
  assert.notEqual(g.state('state.runId'), run);
});

test('only owned items can be equipped, all ten outfit slots persist, and every reset restores its default', async t => {
  const g = await game(t);
  g.evaluate('for(const item of WARDROBE_ITEMS)equipWardrobeItem(item.id);equipWardrobeItem("not-a-real-item");equipWardrobeItem("reset:not-a-slot");');
  assert.deepEqual(plain(g.state('wardrobeProgress.equipped')), DEFAULTS);
  // Ownership is an explicit outfit-rendering fixture; completion accounting
  // is independently exercised through real settlement in the tests above.
  g.evaluate('wardrobeProgress.unlocked=WARDROBE_ITEMS.map(item=>item.id);renderWardrobe();saveCurrentSession(true);');
  g.click('btn-wardrobe');
  await tick();
  const equipped={...DEFAULTS};
  for(const [id,slot] of Object.entries(ITEMS)) {
    const button=g.d.querySelector(`#wardrobe-collection [data-equip="${id}"]`);
    assert.ok(button&&!button.disabled,`${id} can be selected after ownership`);
    button.focus();button.click();await tick();
    equipped[slot]=id;
    assert.deepEqual(plain(g.state('wardrobeProgress.equipped')),equipped);
    assert.equal(g.d.activeElement.dataset.equip,id,'rerendering an item preserves keyboard focus');
    assert.equal(g.d.activeElement.isConnected,true);
    assertOutfitLayers(g,equipped);
  }
  const stored = g.storage();g.close();
  const restored = await game(t, {storage:stored,stayHome:true});
  assert.deepEqual(plain(restored.state('wardrobeProgress.equipped')), equipped);
  assertOutfitLayers(restored,equipped);
  for(const [slot,fallback] of Object.entries(DEFAULTS)) {
    assert.equal(restored.state(`equipWardrobeItem(${JSON.stringify('reset:'+slot)})`),true);
    equipped[slot]=fallback;
    assert.deepEqual(plain(restored.state('wardrobeProgress.equipped')),equipped);
  }
  restored.evaluate('for(const item of WARDROBE_ITEMS)equipWardrobeItem(item.id);equipWardrobeItem("reset:all");');
  assert.deepEqual(plain(restored.state('wardrobeProgress.equipped')),DEFAULTS);
  assertOutfitLayers(restored,DEFAULTS);
  restored.evaluate('equipWardrobeItem("bow_rose");equipWardrobeItem("dress_sky");');
  restored.evaluate('equipWardrobeItem("none");equipWardrobeItem("patched");');
  assert.deepEqual(plain(restored.state('wardrobeProgress.equipped')), DEFAULTS,'the old reset aliases still work');
});

test('an old two-slot wardrobe v1 retains its outfits and adds natural defaults for the new slots', async t => {
  const source=await game(t);
  source.evaluate('saveCurrentSession(true);');
  const profile=JSON.parse(source.w.localStorage.getItem(PROFILE));
  profile.wardrobe={version:1,level:8,unlocked:['bow_rose','dress_sky'],equipped:{hair:'bow_rose',dress:'dress_sky'}};
  const restored=await game(t,{storage:{[PROFILE]:JSON.stringify(profile)},stayHome:true});
  assert.equal(restored.state('wardrobeProgress.level'),8);
  assert.deepEqual(plain(restored.state('wardrobeProgress.unlocked')),['bow_rose','dress_sky']);
  const expected={...DEFAULTS,hair:'bow_rose',dress:'dress_sky'};
  assert.deepEqual(plain(restored.state('wardrobeProgress.equipped')),expected);
  assertOutfitLayers(restored,expected);
  restored.click('btn-home-wardrobe');
  assert.deepEqual([...restored.d.querySelectorAll('#wardrobe-collection button[data-equip]')].map(button=>button.dataset.equip).sort(),['bow_rose','dress_sky']);
});

test('finishing a level with no random gift still advances without inventing an award', async t => {
  const g=await game(t);
  for(const level of [1,2,3]) {
    startLevel(g,level,[]);finish(g);
    assert.equal(g.state('wardrobeProgress.level'),level+1);
    assert.deepEqual(plain(g.state('wardrobeProgress.unlocked')),[]);
    assert.deepEqual(plain(g.state('careRecords.history[0].wardrobeGifts')),[]);
    const result=g.d.getElementById('result-modal');
    assert.equal(result.querySelector('[data-item-id]'),null);
    assert.doesNotMatch(result.textContent,
      /第\s*[\d一二三四五六七八九十]+\s*关[^。！？\n]{0,18}(?:发现|获得|解锁)|再完成[^。！？\n]{0,12}关就能|每\s*[三五35]\s*关/,
      `level ${level} never promises a scheduled gift`);
  }
});

test('an old v3 care resumes intact, then starts the new adventure at its simple first level', async t => {
  const source=await game(t,{legacyRecipe:true});
  source.evaluate('state.score=321;state.pimples[0].steamed=.81;saveCurrentSession(true);');
  const legacy=JSON.parse(source.w.localStorage.getItem(PROFILE));
  const originalRun=legacy.session.data.runId;
  const originalCount=legacy.session.data.pimples.length;
  delete legacy.wardrobe;
  delete legacy.session.data.runLevel;
  delete legacy.session.data.legacyCareSession;
  delete legacy.session.data.discoveredGifts;
  for(const list of [legacy.session.data.pimples,legacy.session.data.initialPimples]) {
    for(const p of list){delete p.linkedPore;delete p.giftId;}
  }
  const restored=await game(t,{storage:{[PROFILE]:JSON.stringify(legacy)}});
  assert.equal(restored.state('state.runId'),originalRun);
  assert.equal(restored.state('state.pimples.length'),originalCount);
  assert.equal(restored.state('state.score'),321);
  assert.equal(restored.state('state.pimples[0].steamed'),.81);
  assert.equal(restored.state('state.legacyCareSession'),true);
  assert.equal(restored.d.getElementById('current-level').textContent,'继续上次护理');
  assert.equal(restored.state('wardrobeProgress.level'),1);
  finish(restored);
  assert.equal(restored.state('careRecords.history[0].legacyCareSession'),true);
  assert.equal(restored.state('careRecords.history[0].wardrobeLevel'),0);
  assert.deepEqual(plain(restored.state('careRecords.history[0].wardrobeGifts')),[]);
  assert.equal(restored.state('wardrobeProgress.level'),1);
  restored.evaluate('openSettlementModal();');
  assert.equal(restored.state('wardrobeProgress.level'),1,'reopening the old result cannot skip the new first level');
  restored.click('btn-next-face');
  assert.notEqual(restored.state('state.runId'),originalRun);
  assert.equal(restored.state('state.legacyCareSession'),false);
  assert.equal(restored.state('state.runLevel'),1);
  assert.equal(restored.state('state.pimples.length'),3);
  assert.equal(restored.state('state.pimples.every(p=>p.type==="blackhead"&&!p.linkedPore&&!p.sharedPore)'),true);
  assert.equal(restored.d.getElementById('current-level').textContent,'第 1 关');
});

test('a failed settlement keeps the old snapshot intact and retries its gift atomically', async t => {
  const g = await game(t);
  startLevel(g, 5, ['dress_sky']);discover(g);
  const before = g.w.localStorage.getItem(PROFILE);
  const native = g.w.Storage.prototype.setItem;
  g.w.Storage.prototype.setItem = function(key, value) {
    if (key === PROFILE) throw new g.w.DOMException('Full storage', 'QuotaExceededError');
    return native.call(this, key, value);
  };
  finish(g);
  assert.equal(g.w.localStorage.getItem(PROFILE), before);
  assert.equal(g.state('wardrobeProgress.level'), 6);
  assert.deepEqual(plain(g.state('wardrobeProgress.unlocked')), ['dress_sky']);
  assert.equal(g.state('careControl.saveIssue'), true);
  g.w.Storage.prototype.setItem = native;
  g.d.querySelector('#result-modal .save-retry').click();
  assert.equal(await g.evaluate('careSaveRetryReady'), true);
  assert.equal(g.state('careControl.saveIssue'), false);
  g.evaluate('openSettlementModal();');
  assert.equal(g.state('careRecords.history.length'), 1);
  const saved = g.storage();g.close();
  const restored = await game(t, {storage:saved});
  assert.equal(restored.state('wardrobeProgress.level'), 6);
  assert.deepEqual(plain(restored.state('wardrobeProgress.unlocked')), ['dress_sky']);
});

test('a page without care ownership cannot equip or overwrite another page’s outfit', async t => {
  const hub = createStorageHub();t.after(hub.close);
  const first = await game(t, {storageHub:hub});
  startLevel(first,3,['bow_rose']);discover(first);finish(first);
  first.evaluate('equipWardrobeItem("bow_rose");');
  const second = await game(t, {storageHub:hub,stayHome:true});
  assert.equal(second.state('careControl.owned'), false);
  const saved = hub.snapshot()[PROFILE];
  second.evaluate('equipWardrobeItem("none");equipWardrobeItem("dress_sky");');
  assert.equal(hub.snapshot()[PROFILE], saved);
  assert.equal(first.state('wardrobeProgress.equipped.hair'), 'bow_rose');
});
