const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');
const {setupRound} = require('./round-fixture.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);

async function game(t, options = {}) {
  const g = await createGame({seed:44219, ...options});
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  return g;
}

function fixture(g, ids, level = 3) {
  setupRound(g,{level});
  g.evaluate(`
    ${JSON.stringify(ids)}.forEach((id,index)=>state.pimples[index].giftId=id);
    state.initialPimples.forEach(p=>p.giftId=state.pimples.find(q=>q.id===p.id).giftId);
    saveCurrentSession(true);`);
}

function findFood(g) {
  g.evaluate(`state.pimples.forEach(p=>{
    if(!p.giftId)return;
    if(p.sharedPore){p.sharedPore.phase='done';if(p.sharedPore.mode==='sequential'){p.type='whitehead';p.cfg=CONFIG.TYPES.WHITEHEAD;}}
    p.state=P_STATE.OOZING;revealWardrobeFind(p);
  });saveCurrentSession(true);`);
}

function finish(g) {
  g.evaluate(`state.pimples.forEach(p=>{
    if(p.sharedPore){p.sharedPore.phase='done';if(p.sharedPore.mode==='sequential'){p.type='whitehead';p.cfg=CONFIG.TYPES.WHITEHEAD;}}
    p.state=P_STATE.HEALED;p.healProgress=1;
  });updateHUD();`);
  g.click('btn-ice-quick');g.frame(65);
  assert.equal(g.state('state.settled'), true);
}

test('food inventory and hunger migrate safely without changing existing outfits', async t => {
  const g=await game(t);
  const data=plain(g.state(`normalizeWardrobeProgress({version:2,level:9,unlocked:['dress_sky'],equipped:{dress:'dress_sky'},
    pantry:{food_pudding:2,food_cocoa:-1,food_onigiri:1.5,food_omurice:1000,unknown:99},hunger:65})`));
  assert.equal(data.version,3);assert.equal(data.level,9);assert.equal(data.hunger,65);
  assert.deepEqual(data.pantry,{food_pudding:2});assert.equal(data.equipped.dress,'dress_sky');
  for(const hunger of [-1,101,1.5,'42',null]) {
    assert.equal(g.state(`normalizeWardrobeProgress({hunger:${JSON.stringify(hunger)}}).hunger`),38);
  }
  assert.equal(g.state('normalizeWardrobeProgress({hunger:0}).hunger'),0);
  assert.equal(g.state('normalizeWardrobeProgress({hunger:100}).hunger'),100);
  assert.deepEqual(plain(g.state('normalizeWardrobeProgress({version:1,unlocked:[],equipped:{}}).pantry')),{});
});

test('food emerges from its assigned pore, is granted once on completion, and is consumed once through the UI', async t => {
  const g=await game(t), food=plain(g.state('FOOD_ITEMS[0]'));
  fixture(g,[food.id]);
  g.evaluate(`wardrobeProgress.pantry[${JSON.stringify(food.id)}]=1;wardrobeProgress.hunger=38;`);
  const run=g.state('state.runId');findFood(g);
  const flight=g.d.querySelector('.gift-flight');
  assert.equal(flight.dataset.itemId,food.id);assert.equal(flight.dataset.sourcePimpleId,'1');
  assert.ok(flight.querySelector('[data-food-item]'),'the emerging reward is a food illustration');
  assert.equal(g.state(`wardrobeProgress.pantry[${JSON.stringify(food.id)}]`),1,'discovery has not granted the food');
  finish(g);
  assert.equal(g.state(`wardrobeProgress.pantry[${JSON.stringify(food.id)}]`),2);
  assert.equal(g.state('wardrobeProgress.hunger'),50);
  assert.deepEqual(plain(g.state('wardrobeProgress.unlocked')),[]);
  assert.deepEqual(plain(g.state('careRecords.history[0].foodGifts')),[food.id]);
  assert.equal(g.state('careRecords.history[0].runId'),run);
  g.evaluate('openSettlementModal();openSettlementModal();');
  assert.equal(g.state(`wardrobeProgress.pantry[${JSON.stringify(food.id)}]`),2);
  assert.equal(g.state('wardrobeProgress.hunger'),50,'reopening a completed result never adds hunger');
  g.click('btn-open-wardrobe-result');
  assert.equal(g.d.getElementById('wardrobe-food-panel').hidden,false);
  g.d.querySelector(`[data-feed="${food.id}"]`).click();
  assert.equal(g.state(`wardrobeProgress.pantry[${JSON.stringify(food.id)}]`),1);
  assert.equal(g.state('wardrobeProgress.hunger'),50-food.satiety);
  assert.equal(g.d.getElementById('wardrobe-status').textContent,'谢谢你的款待！');
  assert.match(g.d.getElementById('wardrobe-girl-caption').textContent,/谢谢你的款待/,
    'the girl thanks the player beside her portrait, as well as in the live status');
  const profile=JSON.parse(g.w.localStorage.getItem(PROFILE));
  assert.equal(profile.wardrobe.pantry[food.id],1);
  assert.equal(profile.wardrobe.hunger,50-food.satiety,'consumption and hunger use the same profile write');
  const storage=g.storage();g.close();
  const restored=await game(t,{storage,stayHome:true});
  assert.equal(restored.state(`wardrobeProgress.pantry[${JSON.stringify(food.id)}]`),1);
  assert.equal(restored.state('wardrobeProgress.hunger'),50-food.satiety);
});

test('a meal clamps hunger at zero, removes the last portion, and never wastes food while full', async t => {
  const g=await game(t), food=plain(g.state('FOOD_ITEMS[2]'));
  g.evaluate(`wardrobeProgress.pantry={${JSON.stringify(food.id)}:1,food_pudding:2};wardrobeProgress.hunger=9;renderWardrobe();`);
  g.click('btn-wardrobe');g.click('wardrobe-tab-food');
  const stale=g.d.querySelector(`[data-feed="${food.id}"]`);stale.click();
  assert.equal(g.state('wardrobeProgress.hunger'),0);
  assert.equal(g.state(`Object.hasOwn(wardrobeProgress.pantry,${JSON.stringify(food.id)})`),false);
  assert.equal(g.d.querySelector(`[data-feed="${food.id}"]`),null,'a consumed final portion disappears');
  assert.equal(g.d.querySelector('[data-feed="food_pudding"]').disabled,true);
  const before=plain(g.state('wardrobeProgress'));
  stale.click();
  assert.equal(g.state('feedGirl("food_pudding")'),false);
  assert.equal(g.state('feedGirl("unknown")'),false);
  assert.deepEqual(plain(g.state('wardrobeProgress')),before);
  assert.equal(g.d.activeElement.id,'wardrobe-tab-food','focus stays on an existing control after the last portion');
});

test('saved food finds resume without rerolling, revealing twice, or awarding undiscovered food', async t => {
  const source=await game(t), foods=plain(source.state('FOOD_ITEMS.slice(0,2).map(item=>item.id)'));
  fixture(source,foods,4);findFood(source);
  const p=plain(source.state('state.pimples.find(p=>p.giftId)'));
  assert.equal(source.state(`revealWardrobeFind(state.pimples.find(p=>p.id===${p.id}))`),false);
  const storage=source.storage();source.close();
  const resumed=await game(t,{storage});
  assert.deepEqual(plain(resumed.state('state.discoveredGifts')).sort(),foods.slice().sort());
  assert.deepEqual(plain(resumed.state('wardrobeProgress.pantry')),{});
  finish(resumed);
  for(const id of foods) assert.equal(resumed.state(`wardrobeProgress.pantry[${JSON.stringify(id)}]`),1);
  fixture(resumed,[foods[0]],5);
  // Exercise the award boundary directly: updateHUD normally reveals every
  // emptied pore, so an undiscovered fixture must not simulate that update.
  resumed.evaluate('state.settled=true;completeWardrobeLevel({});');
  assert.equal(resumed.state(`wardrobeProgress.pantry[${JSON.stringify(foods[0])}]`),1,'an assigned but undiscovered food is not granted');
  assert.equal(resumed.state('wardrobeProgress.hunger'),62);
});

test('a waiting second page cannot consume food or change the active page hunger', async t => {
  const hub=createStorageHub();
  const active=await game(t,{storageHub:hub});
  active.evaluate('wardrobeProgress.pantry={food_pudding:2};wardrobeProgress.hunger=60;persistSaveData();saveCurrentSession(true);');
  const waiting=await game(t,{storageHub:hub});await tick();
  assert.equal(waiting.state('careControl.owned'),false);
  assert.equal(waiting.state('feedGirl("food_pudding")'),false);
  const saved=JSON.parse(active.w.localStorage.getItem(PROFILE));
  assert.equal(saved.wardrobe.pantry.food_pudding,2);assert.equal(saved.wardrobe.hunger,60);
  active.click('btn-wardrobe');active.click('wardrobe-tab-food');
  active.d.querySelector('[data-feed="food_pudding"]').click();
  assert.equal(active.state('wardrobeProgress.pantry.food_pudding'),1);
  assert.equal(active.state('wardrobeProgress.hunger'),36);
  hub.flush();await tick();
  const current=JSON.parse(active.w.localStorage.getItem(PROFILE));
  assert.equal(current.wardrobe.pantry.food_pudding,1);assert.equal(current.wardrobe.hunger,36);
});
