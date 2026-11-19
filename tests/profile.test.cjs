const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame,createStorageHub} = require('./harness.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const read = g => JSON.parse(g.w.localStorage.getItem(PROFILE));
const tick = () => new Promise(setImmediate);

function rejectProfileWrites(g) {
  const nativeSet = g.w.Storage.prototype.setItem;
  g.w.Storage.prototype.setItem = function(key,value) {
    if(key===PROFILE)throw new g.w.DOMException('Full storage','QuotaExceededError');
    return nativeSet.call(this,key,value);
  };
  return () => {g.w.Storage.prototype.setItem = nativeSet;};
}

function loosen(g) {
  const p=g.state('state.pimples.find(p=>p.type==="blackhead"&&!p.pierced)');
  g.click('tool-needle');g.mouse('skin-canvas','mousedown',p.x,p.y);g.mouse(g.w,'mouseup',p.x,p.y);g.frame();
}

test('a failed settlement write cannot persist income without its record or delete the active care', async t => {
  const g = await createGame({seed:31,storage:{pimple_clinic_coins:'1000'}});t.after(g.close);g.frame();
  const before = g.w.localStorage.getItem(PROFILE);
  const nativeSet = g.w.Storage.prototype.setItem;
  g.w.Storage.prototype.setItem = function(key,value) {
    if(key===PROFILE)throw new g.w.DOMException('Full storage','QuotaExceededError');
    return nativeSet.call(this,key,value);
  };
  // Isolate payment from extraction mechanics; ice, settlement and retries are real.
  g.evaluate('state.score=1200;state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  g.click('btn-ice-quick');g.frame(65);
  assert.equal(g.state('state.settled'),true);
  assert.equal(g.state('state.coins'),1280);
  assert.equal(g.w.localStorage.getItem(PROFILE),before,'the whole previous snapshot survives a failed write');
  assert.equal(read(g).coins,1000);assert.equal(read(g).records.history.length,0);assert.ok(read(g).session);
  g.w.Storage.prototype.setItem = nativeSet;
  assert.equal(g.evaluate('saveCurrentSession()'),true);
  const saved = read(g);
  assert.equal(saved.coins,1280);assert.equal(saved.records.history.length,1);assert.equal(saved.session,null);
  g.evaluate('openSettlementModal();openSettlementModal();saveCurrentSession();');
  assert.equal(read(g).coins,1280);assert.equal(read(g).records.history.length,1);
  const restored = await createGame({storage:g.storage()});t.after(restored.close);restored.frame();
  assert.equal(restored.state('state.coins'),1280);
  assert.equal(read(restored).records.history.length,1);
  assert.deepEqual(g.runtimeErrors,[]);assert.deepEqual(restored.runtimeErrors,[]);
});

test('an unreadable or newer canonical profile is preserved for recovery', async t => {
  for(const raw of ['{broken',JSON.stringify({version:4,revision:1,coins:900,upgrades:{}})]) {
    const g = await createGame({storage:{[PROFILE]:raw,pimple_clinic_coins:'90'}});t.after(g.close);g.frame();
    assert.equal(g.state('careControl.owned'),false);
    assert.equal(g.d.getElementById('storage-gate-modal').classList.contains('open'),true);
    assert.equal(g.w.localStorage.getItem(PROFILE),raw);
    g.click('btn-continue-here');await g.evaluate('careControlReady');
    assert.equal(g.w.localStorage.getItem(PROFILE),raw);
    assert.deepEqual(g.runtimeErrors,[]);
  }
});

test('unavailable local storage leaves the game playable and makes the limitation visible', async t => {
  const g = await createGame({seed:32,setupWindow(w) {
    Object.defineProperty(w,'localStorage',{configurable:true,get(){throw new w.DOMException('Storage blocked','SecurityError');}});
  }});t.after(g.close);g.frame();
  assert.equal(g.state('careControl.volatile'),true);assert.equal(g.state('careControl.owned'),true);
  assert.ok(g.state('state.pimples.length')>0);
  assert.match(g.d.getElementById('hint-banner').textContent,/无法保存/);
  const p=g.state('state.pimples.find(p=>p.type==="blackhead")');
  g.click('tool-needle');g.mouse('skin-canvas','mousedown',p.x,p.y);g.mouse(g.w,'mouseup',p.x,p.y);g.frame();
  assert.equal(p.pierced,true);assert.ok(g.state('state.score')>0);
  const score=g.state('state.score');
  g.w.dispatchEvent(new g.w.PageTransitionEvent('pagehide',{persisted:true}));
  await tick();
  g.w.dispatchEvent(new g.w.PageTransitionEvent('pageshow',{persisted:true}));
  await g.evaluate('careControlReady');g.frame();
  assert.equal(g.state('careControl.owned'),true);assert.equal(g.state('state.score'),score);
  loosen(g);assert.ok(g.state('state.score')>score,'returning from page cache preserves playable memory');
  assert.deepEqual(g.runtimeErrors,[]);
});

test('page-cache return retries an unsaved snapshot when the stored baseline has not changed', async t => {
  const g = await createGame({seed:33});t.after(g.close);g.frame();
  const restoreWrites=rejectProfileWrites(g);loosen(g);
  const score=g.state('state.score');assert.equal(score,30);assert.equal(read(g).session.data.score,0);
  g.w.dispatchEvent(new g.w.PageTransitionEvent('pagehide',{persisted:true}));await tick();
  assert.ok(g.state('careControl.unsavedDraft'));
  restoreWrites();
  g.w.dispatchEvent(new g.w.PageTransitionEvent('pageshow',{persisted:true}));
  await g.evaluate('careControlReady');g.frame();
  assert.equal(g.state('careControl.owned'),true);assert.equal(g.state('state.score'),score);
  assert.equal(read(g).session.data.score,score);assert.equal(g.state('careControl.unsavedDraft'),null);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('a newer saved profile does not silently replace an unsaved page-cache draft', async t => {
  const hub=createStorageHub({}, {autoFlush:false});
  const a=await createGame({storageHub:hub,seed:34});t.after(a.close);a.frame();
  const restoreWrites=rejectProfileWrites(a);loosen(a);
  a.w.dispatchEvent(new a.w.PageTransitionEvent('pagehide',{persisted:true}));await tick();restoreWrites();
  const b=await createGame({storageHub:hub,seed:35});t.after(b.close);b.frame();loosen(b);loosen(b);
  const saved=hub.snapshot()[PROFILE],savedScore=b.state('state.score');
  a.w.dispatchEvent(new a.w.PageTransitionEvent('pageshow',{persisted:true}));await a.evaluate('careControlReady');
  a.click('btn-continue-here');
  for(let i=0;i<6;i++){hub.flush();await tick();}
  assert.equal(await a.evaluate('careControlReady'),false);
  assert.equal(a.state('careControl.conflict'),true);assert.equal(a.state('state.score'),30);
  assert.equal(hub.snapshot()[PROFILE],saved);assert.ok(a.state('careControl.unsavedDraft'));
  assert.equal(a.d.getElementById('btn-continue-here').textContent,'使用已保存进度');
  assert.match(a.d.getElementById('storage-gate-status').textContent,/放弃这页未保存/);
  a.click('btn-continue-here');await a.evaluate('careControlReady');
  assert.equal(a.state('careControl.owned'),true);assert.equal(a.state('state.score'),savedScore);
  assert.equal(a.state('careControl.unsavedDraft'),null);
  assert.deepEqual(a.runtimeErrors,[]);assert.deepEqual(b.runtimeErrors,[]);
});
