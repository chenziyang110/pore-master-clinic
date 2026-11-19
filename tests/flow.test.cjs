const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const VIEW = 'pimple_clinic_view_v1';
const tick = () => new Promise(setImmediate);
const open = (g, id) => g.d.getElementById(id).classList.contains('open');

function loosenOne(g) {
  const p = g.state('state.pimples.find(p => p.type === "blackhead" && !p.pierced)');
  g.click('tool-needle');
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  g.mouse(g.w, 'mouseup', p.x, p.y);
  assert.equal(p.pierced, true);
  assert.ok(g.state('state.score') > 0);
}

function chooseClient(g, index) {
  if (!open(g, 'clinic-modal')) g.click('btn-clinic');
  g.d.querySelectorAll('#client-list-container .client-card')[index].click();
}

function finish(g) {
  // Only the cleaned targets are a fixture. The real ice action, settlement,
  // payment, result controls and subsequent sessions remain application paths.
  g.evaluate('state.pimples.forEach(p => {p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  g.click('btn-ice-quick');
  g.frame(65);
  assert.equal(g.state('state.settled'), true);
  assert.ok(open(g, 'result-modal'));
}

function assertDensity(g, density) {
  assert.equal(g.state('state.targetDensity'), density);
  for (const button of g.d.querySelectorAll('.preset-btn')) {
    const selected = Number(button.dataset.density) === density;
    assert.equal(button.classList.contains('active'), selected);
    assert.equal(button.getAttribute('aria-pressed'), String(selected));
  }
}

async function deliver(hub) {
  for (let i = 0; i < 8; i++) {
    hub.flush();
    await tick();
    if (!hub.pendingCount) return;
  }
  assert.equal(hub.pendingCount, 0);
}

test('customer switching preserves an unfinished run through cancel, close, Escape and backdrop; confirmation replaces it once', async t => {
  const g = await createGame({legacyRecipe:true,seed:71});t.after(g.close);g.frame();loosenOne(g);
  const run = g.state('state.runId'), score = g.state('state.score');
  const cancel = [
    () => g.click('btn-cancel-reset'),
    () => g.d.querySelector('#reset-modal [data-close-modal]').click(),
    () => g.w.dispatchEvent(new g.w.KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true})),
    () => g.click('reset-modal')
  ];
  for (const dismiss of cancel) {
    chooseClient(g, 1);
    assert.ok(open(g, 'reset-modal'));assert.equal(open(g, 'clinic-modal'), false);
    assert.match(g.d.getElementById('reset-description').textContent, /未完成的进度会舍弃/);
    assert.equal(g.state('state.runId'), run);assert.equal(g.state('state.score'), score);
    dismiss();
    assert.equal(open(g, 'reset-modal'), false);assert.ok(open(g, 'clinic-modal'));
    assert.equal(g.state('state.runId'), run);assert.equal(g.state('state.clientIndex'), 0);
    assert.equal(g.state('state.score'), score);
    assert.equal(JSON.parse(g.storage()[PROFILE]).session.data.runId, run);
  }
  chooseClient(g, 1);g.click('btn-confirm-reset');
  assert.equal(g.state('state.clientIndex'), 1);assert.equal(g.state('state.score'), 0);
  assert.notEqual(g.state('state.runId'), run);assert.equal(open(g, 'reset-modal'), false);
  const nextRun = g.state('state.runId');
  g.click('btn-confirm-reset');
  assert.equal(g.state('state.runId'), nextRun, 'a second click on the old confirmation cannot restart again');
  assert.equal(JSON.parse(g.storage()[PROFILE]).session.data.runId, nextRun);
  assert.deepEqual(g.runtimeErrors, []);
});

test('fresh or completed care switches directly, while the current customer resumes without replacing the run', async t => {
  const g = await createGame({legacyRecipe:true,seed:72});t.after(g.close);g.frame();
  chooseClient(g, 1);assert.equal(g.state('state.clientIndex'), 1);assert.equal(open(g, 'reset-modal'), false);
  loosenOne(g);const run = g.state('state.runId');
  chooseClient(g, 1);assert.equal(g.state('state.runId'), run);assert.equal(open(g, 'reset-modal'), false);
  finish(g);const coins = g.state('state.coins');
  chooseClient(g, 2);
  assert.equal(g.state('state.clientIndex'), 2);assert.equal(g.state('state.coins'), coins);
  assert.equal(open(g, 'reset-modal'), false);assert.equal(open(g, 'result-modal'), false);
  assert.deepEqual(g.runtimeErrors, []);
});

test('a stale confirmation cannot replace a newer run', async t => {
  const g = await createGame({legacyRecipe:true,seed:73});t.after(g.close);g.frame();loosenOne(g);chooseClient(g, 1);
  assert.ok(open(g, 'reset-modal'));
  g.evaluate('generateLevel(8);');
  const run = g.state('state.runId');
  g.click('btn-confirm-reset');
  assert.equal(g.state('state.runId'), run);assert.equal(g.state('state.clientIndex'), 0);
  assert.equal(open(g, 'reset-modal'), false);assertDensity(g, 8);
  assert.deepEqual(g.runtimeErrors, []);
});

test('a page losing care ownership cannot confirm its pending customer switch', async t => {
  const hub = createStorageHub({}, {autoFlush:false});
  const a = await createGame({legacyRecipe:true,seed:74,storageHub:hub});t.after(a.close);a.frame();loosenOne(a);
  chooseClient(a, 1);const run = a.state('state.runId');
  const b = await createGame({legacyRecipe:true,seed:75,storageHub:hub});t.after(b.close);b.frame();
  b.click('btn-continue-here');await deliver(hub);await b.evaluate('careControlReady');
  assert.equal(a.state('careControl.owned'), false);assert.equal(b.state('state.runId'), run);
  a.click('btn-confirm-reset');
  assert.equal(b.state('state.clientIndex'), 0);assert.equal(b.state('state.runId'), run);
  assert.equal(JSON.parse(hub.snapshot()[PROFILE]).session.data.runId, run);
  assert.deepEqual(a.runtimeErrors, []);assert.deepEqual(b.runtimeErrors, []);
});

test('legacy quantity selections survive reload and explicit treatment changes', async t => {
  const g = await createGame({legacyRecipe:true,seed:76});g.frame();finish(g);
  g.d.querySelector('.preset-btn[data-density="11"]').click();assertDensity(g, 11);
  g.evaluate("performTreatmentChange({kind:'restart',clientIndex:state.clientIndex,density:11,runId:state.runId});");assert.equal(g.state('state.pimples.length'), 11);assertDensity(g, 11);
  g.w.dispatchEvent(new g.w.Event('pagehide'));const saved = g.storage();g.close();
  const r = await createGame({legacyRecipe:true,seed:77,storage:saved});t.after(r.close);r.frame();
  assertDensity(r, 11);assert.equal(r.state('state.pimples.length'), 11);
  finish(r);r.evaluate("performTreatmentChange({kind:'restart',clientIndex:state.clientIndex,density:11,runId:state.runId});");assertDensity(r, 11);assert.equal(r.state('state.pimples.length'), 11);
  const otherClient = r.state('state.clientIndex') === 0 ? 1 : 0;
  chooseClient(r, otherClient);assertDensity(r, 0);assert.equal(r.state('state.pimples.length'), 8);
  assert.deepEqual(r.runtimeErrors, []);
});

test('view preference survives completed care, reload and a new customer', async t => {
  const g = await createGame({legacyRecipe:true,seed:78});g.frame();g.click('btn-style-mode');
  assert.equal(g.state('state.styleMode'), 'creamy');finish(g);
  assert.equal(JSON.parse(g.storage()[PROFILE]).session, null);
  const saved = g.storage();g.close();
  const r = await createGame({legacyRecipe:true,seed:79,storage:saved});t.after(r.close);r.frame();
  assert.equal(r.state('state.styleMode'), 'creamy');
  assert.equal(r.d.getElementById('btn-style-mode').getAttribute('aria-pressed'), 'true');
  chooseClient(r, 2);assert.equal(r.state('state.styleMode'), 'creamy');
  assert.deepEqual(JSON.parse(r.storage()[VIEW]), {version:1,styleMode:'creamy'});
  assert.deepEqual(r.runtimeErrors, []);
});

test('view preference migrates a legacy session but an explicit newer choice takes priority', async t => {
  const source = await createGame({legacyRecipe:true,seed:80});source.frame();source.click('btn-style-mode');source.evaluate('saveCurrentSession();');
  const oldSession = JSON.stringify(JSON.parse(source.storage()[PROFILE]).session);source.close();
  const migrated = await createGame({legacyRecipe:true,seed:81,storage:{pimple_clinic_session_v2:oldSession}});t.after(migrated.close);migrated.frame();
  assert.equal(migrated.state('state.styleMode'), 'creamy');assert.equal(JSON.parse(migrated.storage()[VIEW]).styleMode, 'creamy');
  const explicit = await createGame({legacyRecipe:true,seed:82,storage:{pimple_clinic_session_v2:oldSession,[VIEW]:JSON.stringify({version:1,styleMode:'realistic'})}});t.after(explicit.close);explicit.frame();
  assert.equal(explicit.state('state.styleMode'), 'realistic');
  assert.equal(explicit.d.getElementById('btn-style-mode').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(migrated.runtimeErrors, []);assert.deepEqual(explicit.runtimeErrors, []);
});

test('view preference notifications use the latest value without overwriting care resources', async t => {
  const hub = createStorageHub({}, {autoFlush:false});
  const a = await createGame({legacyRecipe:true,seed:83,storageHub:hub});t.after(a.close);a.frame();loosenOne(a);
  const b = await createGame({legacyRecipe:true,seed:84,storageHub:hub});t.after(b.close);b.frame();await deliver(hub);
  const profile = hub.snapshot()[PROFILE];
  a.click('btn-style-mode');a.click('btn-style-mode');a.click('btn-style-mode');
  await deliver(hub);
  assert.equal(a.state('state.styleMode'), 'creamy');assert.equal(b.state('state.styleMode'), 'creamy');
  assert.equal(b.d.getElementById('btn-style-mode').getAttribute('aria-pressed'), 'true');
  assert.equal(hub.snapshot()[PROFILE], profile, 'display changes do not commit another page’s care snapshot');
  assert.equal(b.state('careControl.owned'), false);
  assert.deepEqual(a.runtimeErrors, []);assert.deepEqual(b.runtimeErrors, []);
});

test('invalid or unavailable view storage keeps a playable and selectable display', async t => {
  for (const raw of ['{broken', JSON.stringify({version:2,styleMode:'creamy'}), JSON.stringify({version:1,styleMode:'unknown'})]) {
    const g = await createGame({legacyRecipe:true,seed:85,storage:{[VIEW]:raw}});t.after(g.close);g.frame();
    assert.equal(g.state('state.styleMode'), 'realistic');g.click('btn-style-mode');
    assert.equal(g.state('state.styleMode'), 'creamy');assert.deepEqual(g.runtimeErrors, []);
  }
  const blocked = await createGame({legacyRecipe:true,seed:86,setupWindow(w) {
    Object.defineProperty(w, 'localStorage', {configurable:true,get() {throw new w.DOMException('Blocked', 'SecurityError');}});
  }});t.after(blocked.close);blocked.frame();blocked.click('btn-style-mode');
  assert.equal(blocked.state('state.styleMode'), 'creamy');chooseClient(blocked, 1);
  assert.equal(blocked.state('state.styleMode'), 'creamy');assert.deepEqual(blocked.runtimeErrors, []);
});

