const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');

const PROFILE_KEY = 'pimple_clinic_profile_v3';
const tick = () => new Promise(setImmediate);
const profile = hub => JSON.parse(hub.snapshot()[PROFILE_KEY]);
const owns = game => game.state('careControl.owned');
const gate = game => game.d.getElementById('storage-gate-modal').classList.contains('open');

async function page(t, hub, options = {}) {
  const game = await createGame({seed: 61234, storageHub: hub, ...options});
  t.after(() => { game.close(); assert.deepEqual(game.runtimeErrors, []); });
  await game.evaluate('careControlReady');
  game.frame();
  return game;
}

async function deliver(hub) {
  // Each storage event is a separate task; lock callback promises can enqueue
  // another batch. Do not await a pending takeover before releasing its owner.
  for (let pass = 0; pass < 8; pass++) {
    hub.flush();
    await tick();
    if (!hub.pendingCount) return;
  }
  assert.equal(hub.pendingCount, 0, 'storage notifications should settle');
}

async function takeover(game, hub) {
  assert.ok(gate(game), 'a waiting page exposes its transfer action');
  game.click('btn-continue-here');
  await deliver(hub);
  assert.equal(await game.evaluate('careControlReady'), true);
  await deliver(hub);
  assert.equal(owns(game), true);
  assert.equal(gate(game), false);
}

function nextBlackhead(game) {
  const p = game.state('state.pimples.find(p => p.type === "blackhead" && p.state === P_STATE.INTACT && !p.pierced)');
  assert.ok(p, 'the run has an untreated blackhead');
  return {id: p.id, x: p.x, y: p.y};
}

function loosenOne(game) {
  const p = nextBlackhead(game);
  game.click('tool-needle');
  game.mouse('skin-canvas', 'mousedown', p.x, p.y);
  game.mouse(game.w, 'mouseup', p.x, p.y);
  game.frame();
  assert.equal(game.state(`state.pimples.find(p => p.id === ${p.id}).pierced`), true);
  return p;
}

function finishAccountingFixture(game, score = 1234) {
  // Only cleaning/score is a fixture. The real ice button, simulation,
  // settlement, payment and profile commit remain in the application path.
  game.evaluate(`state.score=${score};state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();`);
  game.click('btn-ice-quick');
  game.frame(65);
  assert.equal(game.state('state.settled'), true);
  assert.ok(game.d.getElementById('result-modal').classList.contains('open'));
}

function startSameCustomerFromClinic(game) {
  const card = [...game.d.querySelectorAll('#client-list-container .client-card')]
    .find(button => button.getAttribute('aria-label').startsWith('阿哲，'));
  assert.ok(card);
  card.click();
  game.frame();
  assert.equal(game.state('state.settled'), false);
  assert.equal(game.state('state.clientIndex'), 0);
}

test('a second page is paused and its resize, inputs and pagehide cannot overwrite the active treatment', {timeout: 10000}, async t => {
  const hub = createStorageHub({}, {autoFlush: false});
  const active = await page(t, hub);
  loosenOne(active);
  const saved = hub.snapshot()[PROFILE_KEY];
  const waiting = await page(t, hub, {width: 296, height: 271, seed: 7});
  assert.equal(owns(active), true);
  assert.equal(owns(waiting), false);
  assert.equal(gate(waiting), true);
  assert.equal(waiting.d.getElementById('btn-continue-here').disabled, false);
  assert.equal(hub.snapshot()[PROFILE_KEY], saved, 'opening the other page does not publish a fresh run');
  waiting.resize(666, 151);
  waiting.frame(3);
  waiting.click('tool-needle');
  waiting.mouse('skin-canvas', 'mousedown', 50, 60);
  waiting.mouse(waiting.w, 'mouseup', 50, 60);
  waiting.w.dispatchEvent(new waiting.w.Event('pagehide'));
  await deliver(hub);
  assert.equal(hub.snapshot()[PROFILE_KEY], saved);
  assert.equal(owns(active), true);
  assert.equal(active.state('state.score'), 30);
  assert.equal(waiting.state('state.pointer.active'), false);
});

test('explicit takeover saves a held action before the 800 ms autosave and resumes its latest state', {timeout: 10000}, async t => {
  const hub = createStorageHub({}, {autoFlush: false});
  const first = await page(t, hub);
  const second = await page(t, hub, {width: 296, height: 271});
  const p = nextBlackhead(first);
  first.click('tool-steam');
  const savedWarmth = profile(hub).session.data.pimples.find(item => item.id === p.id).steamed;
  first.mouse('skin-canvas', 'mousedown', p.x, p.y);
  first.frame(3);
  const latestWarmth = first.state(`state.pimples.find(p => p.id === ${p.id}).steamed`);
  assert.ok(latestWarmth > savedWarmth);
  assert.equal(profile(hub).session.data.pimples.find(item => item.id === p.id).steamed, savedWarmth, 'the periodic save has not fired yet');
  const runId = first.state('state.runId');
  await takeover(second, hub);
  assert.equal(owns(first), false);
  assert.equal(gate(first), true);
  assert.equal(first.state('state.pointer.active'), false);
  assert.equal(second.state('state.pointer.active'), false);
  assert.equal(second.state('state.runId'), runId);
  assert.equal(second.state('state.currentTool'), 'steam');
  assert.equal(second.state(`state.pimples.find(p => p.id === ${p.id}).steamed`), latestWarmth);
  assert.equal(profile(hub).session.data.pimples.find(item => item.id === p.id).steamed, latestWarmth);
  const transferred = hub.snapshot()[PROFILE_KEY];
  first.resize(420, 580);
  first.w.dispatchEvent(new first.w.Event('pagehide'));
  assert.equal(hub.snapshot()[PROFILE_KEY], transferred);
});

test('a newer committed profile rejects stale input and saving before its storage notification arrives', {timeout: 10000}, async t => {
  for (const locks of [true, false]) {
    const hub = createStorageHub({}, {autoFlush: false, locks});
    const old = await page(t, hub);
    const peer = await page(t, hub);
    const p = nextBlackhead(old);
    // Fault fixture: another writer has already committed a newer revision,
    // while this page's storage event is delayed. Local actions still use DOM.
    const newer = profile(hub);
    newer.revision++;
    newer.writer = 'newer-writer-fixture';
    newer.coins = 610;
    newer.session.data.score = 400;
    const committed = JSON.stringify(newer);
    peer.w.localStorage.setItem(PROFILE_KEY, committed);
    assert.equal(owns(old), true, 'the notification has deliberately not run');
    old.click('tool-needle');
    old.mouse('skin-canvas', 'mousedown', p.x, p.y);
    old.mouse(old.w, 'mouseup', p.x, p.y);
    old.resize(296, 271);
    old.w.dispatchEvent(new old.w.Event('pagehide'));
    assert.equal(owns(old), false);
    assert.equal(gate(old), true);
    assert.equal(hub.snapshot()[PROFILE_KEY], committed);
    assert.equal(old.state('state.score'), 0);
    assert.equal(old.state(`state.pimples.find(p => p.id === ${p.id}).pierced`), false);
    await deliver(hub);
    old.close(); peer.close();
  }
});

test('cancelling a queued takeover leaves the owner active and ignores the cancelled notification', {timeout: 10000}, async t => {
  const hub = createStorageHub({}, {autoFlush: false});
  const owner = await page(t, hub);
  const waiting = await page(t, hub);
  const before = hub.snapshot()[PROFILE_KEY];
  waiting.click('btn-continue-here');
  assert.equal(waiting.d.getElementById('btn-cancel-handoff').hidden, false);
  assert.equal(waiting.d.getElementById('btn-continue-here').disabled, true);
  waiting.click('btn-cancel-handoff');
  assert.equal(await waiting.evaluate('careControlReady'), false);
  await deliver(hub);
  assert.equal(owns(owner), true);
  assert.equal(owns(waiting), false);
  assert.equal(gate(waiting), true);
  assert.equal(waiting.d.getElementById('btn-cancel-handoff').hidden, true);
  assert.equal(waiting.d.getElementById('btn-continue-here').disabled, false);
  assert.equal(hub.snapshot()[PROFILE_KEY], before);
  loosenOne(owner);
  assert.equal(profile(hub).session.data.score, 30);
});

test('repeated handoffs keep one run, and closing the owner releases a waiting page without notification delivery', {timeout: 10000}, async t => {
  const hub = createStorageHub({}, {autoFlush: false});
  const a = await page(t, hub);
  const b = await page(t, hub);
  const runId = a.state('state.runId');
  loosenOne(a);
  await takeover(b, hub);
  loosenOne(b);
  await takeover(a, hub);
  loosenOne(a);
  const earnedScore = a.state('state.score');
  await takeover(b, hub);
  assert.equal(b.state('state.score'), earnedScore);
  assert.equal(b.state('state.runId'), runId);
  assert.equal(owns(a), false);
  a.click('btn-continue-here');
  await tick();
  assert.equal(owns(a), false);
  b.close(); // A window/crash release must not depend on the storage event loop.
  await tick();
  assert.equal(await a.evaluate('careControlReady'), true);
  await deliver(hub);
  assert.equal(a.state('state.score'), earnedScore);
  assert.equal(a.state('state.runId'), runId);
  assert.equal(owns(a), true);
});

test('three pages queue transfers in order and the last requester eventually becomes the sole owner', {timeout: 10000}, async t => {
  const hub = createStorageHub({}, {autoFlush: false});
  const a = await page(t, hub);
  const b = await page(t, hub);
  const c = await page(t, hub);
  loosenOne(a);
  const runId = a.state('state.runId');
  b.click('btn-continue-here');
  c.click('btn-continue-here');
  await deliver(hub);
  assert.equal(await c.evaluate('careControlReady'), true);
  await deliver(hub);
  assert.deepEqual([owns(a), owns(b), owns(c)], [false, false, true]);
  assert.equal(c.state('state.score'), 30);
  assert.equal(c.state('state.runId'), runId);
  assert.equal(profile(hub).session.data.runId, runId);
  assert.equal(gate(a), true);
  assert.equal(gate(b), true);
  assert.equal(gate(c), false);
});

test('an upgrade and a new settlement retain balance 1060 and both completed histories across pages', {timeout: 15000}, async t => {
  const hub = createStorageHub({pimple_clinic_coins: '720'}, {autoFlush: false});
  const first = await page(t, hub);
  finishAccountingFixture(first, 1200);
  const firstRunId = first.state('state.runId');
  assert.equal(profile(hub).coins, 1000); // 720 + first customer's 200 + S tip 80.
  const second = await page(t, hub);
  first.click('btn-open-clinic-from-res');
  const upgrade = [...first.d.querySelectorAll('.upgrade-row')].find(row => row.textContent.includes('恒温热喷仪'));
  assert.ok(upgrade);
  assert.equal(upgrade.querySelector('button').disabled, false);
  upgrade.querySelector('button').click();
  assert.equal(first.state('state.coins'), 780);
  assert.equal(profile(hub).upgrades.steamer, true);
  startSameCustomerFromClinic(first);
  const secondRunId = first.state('state.runId');
  assert.notEqual(firstRunId, secondRunId);
  await takeover(second, hub);
  assert.equal(second.state('state.coins'), 780);
  assert.equal(second.state('state.upgrades.steamer'), true);
  assert.equal(second.state('state.runId'), secondRunId);
  finishAccountingFixture(second, 2200);
  const completed = profile(hub);
  assert.equal(completed.coins, 1060); // 720 + 280 - 220 + 280.
  assert.deepEqual(completed.records.history.map(record => record.runId), [secondRunId, firstRunId]);
  assert.equal(completed.records.history[0].upgrades.steamer, true);
  assert.equal(completed.records.history[1].upgrades.steamer, false);
  assert.equal(completed.session, null);
  assert.equal(Object.values(completed.records.bests)[0].completions, 2);
  const saved = hub.snapshot()[PROFILE_KEY];
  first.resize(666, 151);
  first.w.dispatchEvent(new first.w.Event('pagehide'));
  assert.equal(hub.snapshot()[PROFILE_KEY], saved);
});

test('a completed run is paid once when the result is reopened or its completion is replayed after handoff', {timeout: 15000}, async t => {
  const hub = createStorageHub({}, {autoFlush: false});
  const first = await page(t, hub);
  finishAccountingFixture(first, 1234);
  const runId = first.state('state.runId');
  for (let i = 0; i < 3; i++) {
    first.click('btn-open-clinic-from-res');
    first.click('btn-close-clinic');
  }
  assert.equal(profile(hub).coins, 280);
  assert.equal(profile(hub).records.history.length, 1);
  const second = await page(t, hub);
  await takeover(second, hub);
  // Accounting replay fixture: a stale completion carries the already-paid
  // run ID. It still passes through the real ice/settlement UI and ledger.
  second.evaluate(`state.runId=${JSON.stringify(runId)};`);
  finishAccountingFixture(second, 9999);
  assert.equal(profile(hub).coins, 280);
  assert.equal(profile(hub).records.history.length, 1);
  assert.equal(profile(hub).records.history[0].score, 1234);
  assert.equal(Object.values(profile(hub).records.bests)[0].completions, 1);
  assert.equal(second.state('careRecords.history[0].score'), 1234);
  assert.equal(second.state('wardrobeProgress.level'), 2, 'replaying a paid run cannot advance another level');
});

test('v2 resources, guide and partial session migrate once; later legacy writes cannot replace the profile', {timeout: 15000}, async t => {
  const seedHub = createStorageHub({pimple_clinic_coins: '720', pimple_clinic_upgrades: '{"steamer":true}'}, {autoFlush: false});
  const source = await page(t, seedHub);
  finishAccountingFixture(source);
  source.click('btn-open-clinic-from-res');
  startSameCustomerFromClinic(source);
  loosenOne(source);
  const previous = profile(seedHub);
  const legacy = {
    pimple_clinic_coins: String(previous.coins),
    pimple_clinic_upgrades: JSON.stringify(previous.upgrades),
    pimple_clinic_records_v2: JSON.stringify(previous.records),
    pimple_clinic_guide_v1: 'completed',
    pimple_clinic_session_v2: JSON.stringify(previous.session)
  };
  source.close();
  const hub = createStorageHub(legacy, {autoFlush: false});
  const migrated = await page(t, hub);
  assert.equal(migrated.state('state.coins'), 1000);
  assert.equal(migrated.state('state.upgrades.steamer'), true);
  assert.equal(migrated.state('state.score'), 30);
  assert.equal(migrated.state('state.runId'), previous.session.data.runId);
  assert.equal(migrated.state('state.practiceGuide.active'), false);
  assert.equal(profile(hub).records.history.length, 1);
  assert.equal(profile(hub).guide, 'completed');
  loosenOne(migrated);
  for (const [key, value] of Object.entries(legacy)) assert.equal(hub.snapshot()[key], value, `${key} remains migration input only`);
  const canonical = profile(hub);
  migrated.w.localStorage.setItem('pimple_clinic_coins', '0');
  migrated.w.localStorage.setItem('pimple_clinic_upgrades', '{}');
  migrated.w.localStorage.setItem('pimple_clinic_session_v2', 'null');
  migrated.close();
  const reloaded = await page(t, hub);
  assert.equal(reloaded.state('state.coins'), canonical.coins);
  assert.equal(reloaded.state('state.score'), canonical.session.data.score);
  assert.equal(reloaded.state('state.upgrades.steamer'), true);
  assert.equal(profile(hub).records.history.length, 1);
});

test('without Web Locks a cooperative takeover still resumes the saved run and blocks the old page', {timeout: 10000}, async t => {
  const hub = createStorageHub({}, {autoFlush: false, locks: false});
  const first = await page(t, hub);
  const second = await page(t, hub);
  loosenOne(first);
  const runId = first.state('state.runId');
  await takeover(second, hub);
  assert.equal(owns(first), false);
  assert.equal(second.state('state.score'), 30);
  assert.equal(second.state('state.runId'), runId);
  const saved = hub.snapshot()[PROFILE_KEY];
  first.w.dispatchEvent(new first.w.Event('pagehide'));
  first.resize(666, 151);
  assert.equal(hub.snapshot()[PROFILE_KEY], saved);
});

