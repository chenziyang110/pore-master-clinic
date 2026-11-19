const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);

async function game(t, options = {}) {
  const g = await createGame({seed:11019, ...options});
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  return g;
}

function startLevel(g, level) {
  g.evaluate(`document.querySelectorAll('.modal-backdrop.open').forEach(m=>m.classList.remove('open'));
    wardrobeProgress.level=${level};state.runLevel=${level};generateLevel(0);
    state.paused=false;selectTool('steam');saveCurrentSession(true);`);
  g.frame();
}

function discover(g) {
  g.evaluate('state.pimples.forEach(p=>{if(p.giftId){p.state=P_STATE.OOZING;revealWardrobeFind(p);}});saveCurrentSession(true);');
}

function finish(g) {
  // Extraction state is an explicit fixture. The ordinary ice button,
  // settlement, idempotence guard and single profile write award the outfit.
  g.evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  g.click('btn-ice-quick');
  g.frame(65);
  assert.equal(g.state('state.settled'), true);
  assert.equal(g.d.getElementById('result-modal').classList.contains('open'), true);
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
  assert.equal(g.state('state.pimples.every(p=>p.type==="blackhead"&&!p.linkedPore&&!p.giftId)'), true);
});

test('early recipes and third/fifth-level gifts follow the promised progression', async t => {
  const g = await game(t);
  assert.deepEqual(plain(g.state('adventureRecipeFor(1)')), {blackhead:3,whitehead:0,cyst:0});
  assert.deepEqual(plain(g.state('adventureRecipeFor(2)')), {blackhead:4,whitehead:0,cyst:0});
  assert.deepEqual(plain(g.state('adventureRecipeFor(3)')), {blackhead:3,whitehead:1,cyst:0});
  for (const level of [1,2,4]) assert.deepEqual(plain(g.state(`wardrobeRewardsForLevel(${level})`)), []);
  assert.deepEqual(plain(g.state('wardrobeRewardsForLevel(3)')), ['bow_rose']);
  assert.deepEqual(plain(g.state('wardrobeRewardsForLevel(5)')), ['dress_sky']);
  assert.equal(g.state('wardrobeRewardsForLevel(15).length'), 2, 'coinciding milestones grant both categories');
  startLevel(g, 3);
  assert.equal(g.state('state.pimples.filter(p=>p.linkedPore).length'), 1);
  assert.equal(g.state('state.pimples.filter(p=>p.giftId==="bow_rose").length'), 1);
  assert.equal(g.state('wardrobeProgress.unlocked.length'), 0, 'a hidden gift is not owned before care');
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
  startLevel(g,3);discover(g);finish(g);
  g.click('btn-open-wardrobe-result');g.click('btn-close-wardrobe');
  assert.equal(g.d.getElementById('result-modal').classList.contains('open'),true);
  assert.equal(g.state('canRenderCare()'),false);
  assert.equal(g.state('wardrobeProgress.level'),4);
});

test('discoveries persist mid-level and repeated reveals do not duplicate a gift', async t => {
  const g = await game(t);
  startLevel(g, 3);
  discover(g);
  discover(g);
  assert.deepEqual(plain(g.state('state.discoveredGifts')), ['bow_rose']);
  assert.equal(g.state('wardrobeProgress.unlocked.includes("bow_rose")'), false);
  const run = g.state('state.runId');
  const stored = g.storage();
  g.close();
  const restored = await game(t, {storage:stored});
  assert.equal(restored.state('state.runId'), run);
  assert.equal(restored.state('state.runLevel'), 3);
  assert.deepEqual(plain(restored.state('state.discoveredGifts')), ['bow_rose']);
  assert.equal(restored.state('state.pimples.filter(p=>p.linkedPore).length'), 1);
  finish(restored);
  assert.deepEqual(plain(restored.state('wardrobeProgress.unlocked')), ['bow_rose']);
  assert.equal(restored.state('wardrobeProgress.level'), 4);
});

test('settlement unlocks once, advances once and keeps the result free of ratings', async t => {
  const g = await game(t);
  startLevel(g, 3);
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

test('only owned clothes can be equipped and both outfit layers survive reload', async t => {
  const g = await game(t);
  g.evaluate('equipWardrobeItem("dress_sky");equipWardrobeItem("not-a-real-item");');
  assert.deepEqual(plain(g.state('wardrobeProgress.equipped')), {hair:'none',dress:'patched'});
  startLevel(g, 3);discover(g);finish(g);
  g.click('btn-open-wardrobe-result');
  await tick();
  const bow=g.d.querySelector('#wardrobe-hair [data-equip="bow_rose"]');
  bow.focus();bow.click();await tick();
  assert.equal(g.state('wardrobeProgress.equipped.hair'), 'bow_rose');
  assert.equal(g.d.activeElement.dataset.equip,'bow_rose','rerendering the equipped item preserves keyboard focus');
  assert.equal(g.d.activeElement.isConnected,true);
  g.click('btn-close-wardrobe');
  startLevel(g, 5);discover(g);finish(g);
  g.click('btn-open-wardrobe-result');
  g.d.querySelector('#wardrobe-dresses [data-equip="dress_sky"]').click();
  assert.deepEqual(plain(g.state('wardrobeProgress.equipped')), {hair:'bow_rose',dress:'dress_sky'});
  const stored = g.storage();g.close();
  const restored = await game(t, {storage:stored,stayHome:true});
  assert.deepEqual(plain(restored.state('wardrobeProgress.equipped')), {hair:'bow_rose',dress:'dress_sky'});
  assert.equal(restored.state('wardrobeProgress.level'), 6);
  restored.evaluate('equipWardrobeItem("none");equipWardrobeItem("patched");');
  assert.deepEqual(plain(restored.state('wardrobeProgress.equipped')), {hair:'none',dress:'patched'});
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
  assert.equal(restored.state('state.pimples.every(p=>p.type==="blackhead"&&!p.linkedPore)'),true);
  assert.equal(restored.d.getElementById('current-level').textContent,'第 1 关');
});

test('a failed settlement keeps the old snapshot intact and retries its gift atomically', async t => {
  const g = await game(t);
  startLevel(g, 5);discover(g);
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
  startLevel(first,3);discover(first);finish(first);
  first.evaluate('equipWardrobeItem("bow_rose");');
  const second = await game(t, {storageHub:hub,stayHome:true});
  assert.equal(second.state('careControl.owned'), false);
  const saved = hub.snapshot()[PROFILE];
  second.evaluate('equipWardrobeItem("none");equipWardrobeItem("dress_sky");');
  assert.equal(hub.snapshot()[PROFILE], saved);
  assert.equal(first.state('wardrobeProgress.equipped.hair'), 'bow_rose');
});
