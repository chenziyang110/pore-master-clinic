const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const notice = g => g.d.getElementById('save-notice');
const saved = g => JSON.parse(g.w.localStorage.getItem(PROFILE));

function loosen(g) {
  const p = g.state('state.pimples.find(p=>p.type==="blackhead"&&!p.pierced)');
  g.click('tool-needle');
  g.mouse('skin-canvas','mousedown',p.x,p.y);
  g.mouse(g.w,'mouseup',p.x,p.y);
  g.frame();
  return p;
}

function temporaryStorage() {
  let blocked = true;
  return {
    allow() { blocked = false; },
    setupWindow(w) {
      const write = w.Storage.prototype.setItem;
      w.Storage.prototype.setItem = function(key,value) {
        if (blocked) throw new w.DOMException('Storage blocked','SecurityError');
        return write.call(this,key,value);
      };
    }
  };
}

test('temporary-care warning remains visible through tools, dialogs and settlement', async t => {
  const access = temporaryStorage();
  const g = await createGame({seed:91,setupWindow:access.setupWindow});t.after(g.close);g.frame();
  assert.equal(g.state('careControl.volatile'),true);
  for (const tool of ['tool-needle','tool-tweezers','tool-steam']) {
    g.click(tool);
    assert.equal(notice(g).hidden,false);
    assert.match(notice(g).textContent,/本局仅临时保留/);
  }
  g.click('btn-help');
  assert.equal(g.d.querySelector('#help-modal .save-notice').hidden,false);
  g.click('btn-close-help');
  g.evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  g.click('btn-ice-quick');g.frame(65);
  assert.equal(g.state('state.settled'),true);
  assert.equal(g.d.querySelector('#result-modal .save-notice').hidden,false);
  assert.match(g.d.querySelector('#result-modal .save-notice').textContent,/关闭页面会丢失进度/);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('a failed write remains visible until a real retry succeeds, including inside a dialog', async t => {
  const g = await createGame({seed:92});t.after(g.close);g.frame();
  const write = g.w.Storage.prototype.setItem;
  g.w.Storage.prototype.setItem = function(key,value) {
    if(key===PROFILE)throw new g.w.DOMException('Full storage','QuotaExceededError');
    return write.call(this,key,value);
  };
  loosen(g);
  const score=g.state('state.score');
  assert.equal(saved(g).session.data.score,0);
  g.click('tool-steam');g.click('btn-help');
  assert.equal(g.d.querySelector('#help-modal .save-notice').hidden,false);
  assert.match(notice(g).textContent,/进度尚未保存/);
  g.w.Storage.prototype.setItem=write;
  g.d.querySelector('#help-modal .save-retry').click();
  assert.equal(await g.evaluate('careSaveRetryReady'),true);
  assert.equal(saved(g).session.data.score,score);
  assert.equal(notice(g).hidden,true);
  assert.equal(g.d.querySelector('#help-modal .save-notice').hidden,true);
  assert.equal(g.d.getElementById('help-modal').classList.contains('open'),true);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('temporary care can recover storage without replacing the current treatment or dialog', async t => {
  const access=temporaryStorage();
  const g=await createGame({seed:93,setupWindow:access.setupWindow});t.after(g.close);g.frame();
  const p=loosen(g),run=g.state('state.runId'),score=g.state('state.score');
  g.click('btn-clinic');access.allow();
  g.d.querySelector('#clinic-modal .save-retry').click();
  assert.equal(await g.evaluate('careSaveRetryReady'),true);
  assert.equal(g.state('careControl.volatile'),false);
  assert.equal(g.state('careControl.owned'),true);
  assert.equal(g.state('state.runId'),run);
  assert.equal(g.state('state.score'),score);
  assert.equal(p.pierced,true);
  assert.equal(g.d.getElementById('clinic-modal').classList.contains('open'),true);
  assert.equal(saved(g).session.data.runId,run);
  assert.equal(saved(g).session.data.score,score);
  assert.equal(notice(g).hidden,true);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('recovering temporary storage never overwrites a different saved profile', async t => {
  const other=await createGame({seed:94,storage:{pimple_clinic_coins:'900'}});t.after(other.close);other.frame();
  const newer=other.w.localStorage.getItem(PROFILE);
  const access=temporaryStorage();
  const g=await createGame({seed:95,setupWindow:access.setupWindow});t.after(g.close);g.frame();
  loosen(g);const score=g.state('state.score');
  access.allow();g.w.localStorage.setItem(PROFILE,newer);
  g.click('btn-retry-save');
  assert.equal(await g.evaluate('careSaveRetryReady'),false);
  assert.equal(g.w.localStorage.getItem(PROFILE),newer);
  assert.equal(g.state('state.score'),score);
  assert.equal(g.state('careControl.conflict'),true);
  assert.equal(g.state('careControl.owned'),false);
  assert.equal(notice(g).hidden,false);
  assert.match(g.d.getElementById('storage-gate-status').textContent,/放弃这页未保存/);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('saving a completed temporary care preserves its result and pays only once', async t => {
  const access=temporaryStorage();
  const g=await createGame({seed:96,setupWindow:access.setupWindow});t.after(g.close);g.frame();
  g.evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  g.click('btn-ice-quick');g.frame(65);
  const coins=g.state('state.coins'),run=g.state('state.runId');
  access.allow();g.d.querySelector('#result-modal .save-retry').click();
  assert.equal(await g.evaluate('careSaveRetryReady'),true);
  assert.equal(g.state('state.settled'),true);
  assert.equal(g.state('state.runId'),run);
  assert.equal(g.state('state.coins'),coins);
  assert.equal(g.d.getElementById('result-modal').classList.contains('open'),true);
  assert.equal(saved(g).session,null);
  assert.equal(saved(g).records.history.length,1);
  assert.equal(saved(g).coins,coins);
  g.evaluate('openSettlementModal();saveCurrentSession();');
  assert.equal(saved(g).records.history.length,1);
  assert.equal(saved(g).coins,coins);
  assert.deepEqual(g.runtimeErrors,[]);
});

function interruptUnsavedHeat(g) {
  const p=g.state('state.pimples.find(p=>p.type==="blackhead")');
  g.click('tool-steam');
  g.mouse('skin-canvas','mousedown',p.x,p.y);g.frame(3);
  const heat=p.steamed,run=g.state('state.runId');
  assert.ok(heat>0);
  const read=g.w.Storage.prototype.getItem;
  g.w.Storage.prototype.getItem=function(key) {
    if(key===PROFILE||key==='pimple_clinic_owner_v1')throw new g.w.DOMException('Storage blocked','SecurityError');
    return read.call(this,key);
  };
  g.frame();
  assert.equal(g.state('careControl.owned'),false);
  assert.equal(g.state('Boolean(careControl.unsavedDraft)'),true);
  assert.equal(notice(g).hidden,false);
  g.w.Storage.prototype.getItem=read;
  return {heat,run,id:p.id};
}

test('losing storage read access preserves actions before the pending save', async t => {
  const g=await createGame({seed:97});t.after(g.close);g.frame();
  const {heat,run,id}=interruptUnsavedHeat(g);
  g.click('btn-continue-here');
  assert.equal(await g.evaluate('careControlReady'),true);
  assert.equal(g.state('state.runId'),run);
  assert.equal(g.state(`state.pimples.find(p=>p.id===${JSON.stringify(id)}).steamed`),heat);
  assert.equal(saved(g).session.data.pimples.find(p=>p.id===id).steamed,heat);
  assert.equal(notice(g).hidden,true);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('recovering a failed storage read retains the draft when a newer profile exists', async t => {
  const g=await createGame({seed:98});t.after(g.close);g.frame();
  const {heat,id}=interruptUnsavedHeat(g);
  const newer=saved(g);newer.revision+=1;newer.coins+=100;
  const raw=JSON.stringify(newer);g.w.localStorage.setItem(PROFILE,raw);
  g.click('btn-continue-here');
  assert.equal(await g.evaluate('careControlReady'),false);
  assert.equal(g.state('careControl.conflict'),true);
  assert.equal(g.w.localStorage.getItem(PROFILE),raw);
  assert.equal(g.state(`state.pimples.find(p=>p.id===${JSON.stringify(id)}).steamed`),heat);
  assert.equal(notice(g).hidden,false);
  assert.match(g.d.getElementById('storage-gate-status').textContent,/放弃这页未保存/);
  assert.deepEqual(g.runtimeErrors,[]);
});
