const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');
const {setupRound} = require('./round-fixture.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);

function clockFor(window, initial = Date.UTC(2026, 10, 21, 12)) {
  let now = initial, nextId = 100000;
  const tasks = new Map(), nativeClear = window.clearTimeout.bind(window);
  window.Date.now = () => now;
  window.setTimeout = (callback, delay = 0, ...args) => {
    const id = nextId++;
    tasks.set(id, {at: now + Math.max(0, Number(delay) || 0), callback: () => callback.apply(window, args)});
    return id;
  };
  window.clearTimeout = id => { if (!tasks.delete(id)) nativeClear(id); };
  return {
    now: () => now,
    advance(ms) {
      const target = now + ms;
      let iterations = 0;
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++iterations < 10000, 'reminder scheduling must not spin on an unsafe or cooling-down page');
        const [id, task] = next;
        now = task.at; tasks.delete(id); task.callback();
      }
      now = target;
    }
  };
}

function loadImages(window) {
  // Image decoding is covered by wardrobe-feedback; keep its loading timeout
  // independent of the reminder's multi-minute behavioral clock here.
  window.Image = class extends window.EventTarget {
    constructor() { super(); this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this._src = ''; }
    set src(value) {
      this._src = String(value);
      queueMicrotask(() => {
        this.complete = true; this.naturalWidth = 1536; this.naturalHeight = 1024;
        const event = new window.Event('load'); this.onload?.(event); this.dispatchEvent(event);
      });
    }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
  };
}

async function game(t, options = {}) {
  let clock;
  const g = await createGame({seed: 84173, ...options, setupWindow(window) {
    clock = clockFor(window, options.now);
    loadImages(window);
    options.setupWindow?.(window);
  }});
  g.clock = clock;
  let closed = false;
  const close = g.close;
  g.close = () => { if (!closed) { closed = true; close(); } };
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.evaluate('renderScene=()=>{};');
  g.frame(); await tick();
  return g;
}

function prepare(g, {hunger = 100, pantry = {food_pudding: 2}, level = 6, resetReminder = true} = {}) {
  g.evaluate(`wardrobeProgress.hunger=${hunger};wardrobeProgress.pantry=${JSON.stringify(pantry)};
    ${resetReminder ? "wardrobeProgress.hungerReminder={lastRunId:'',nextAt:0};" : ''}`);
  setupRound(g, {level, recipe: {blackhead: 3, whitehead: 0, cyst: 0}, setup: 'finishPracticeGuide(true);'});
}

const open = g => g.d.getElementById('hunger-modal').classList.contains('open');
const read = g => JSON.parse(g.storage()[PROFILE]);

function key(g, value, type = 'keydown', target = g.d.getElementById('skin-canvas'), extra = {}) {
  const event = new g.w.KeyboardEvent(type, {key: value, bubbles: true, cancelable: true, ...extra});
  target.dispatchEvent(event);
  return event;
}

async function show(g) {
  g.clock.advance(12000);
  await tick();
  assert.equal(open(g), true, 'a hungry player with food is asked after entering a quiet care round');
}

test('a quiet care round asks after twelve seconds only at high hunger with real food, and shows the actual percentage', async t => {
  const copies = {};
  for (const [hunger, pantry, expected] of [[79, {food_pudding: 1}, false], [80, {}, false],
    [100, {}, false], [80, {food_pudding: 1}, true], [100, {food_pudding: 1}, true]]) {
    const g = await game(t); prepare(g, {hunger, pantry});
    const before = plain(g.state('({runId:state.runId,pimples:state.pimples,pantry:wardrobeProgress.pantry,hunger:wardrobeProgress.hunger})'));
    g.clock.advance(11999);
    assert.equal(open(g), false, `${hunger}%: entry does not interrupt care immediately`);
    g.clock.advance(1); await tick();
    assert.equal(open(g), expected, `${hunger}% and ${Object.keys(pantry).length} owned food types`);
    assert.deepEqual(plain(g.state('({runId:state.runId,pimples:state.pimples,pantry:wardrobeProgress.pantry,hunger:wardrobeProgress.hunger})')), before,
      'asking never consumes food, changes hunger or restarts the current care');
    if (!expected) continue;
    assert.equal(g.state('state.paused'), true);
    assert.equal(g.d.getElementById('hunger-percent').textContent, `${hunger}%`);
    assert.equal(g.d.getElementById('hunger-meter').getAttribute('aria-valuenow'), String(hunger));
    assert.equal(g.d.getElementById('btn-hunger-feed').dataset.openTab, 'food');
    copies[hunger] = g.d.getElementById('hunger-copy').textContent;
    assert.match(copies[hunger], /吃|饿/);
    const saved = read(g).wardrobe.hungerReminder;
    assert.equal(saved.lastRunId, before.runId, 'showing the request records this exact run');
    assert.equal(saved.nextAt, g.clock.now() + 3 * 60 * 1000, 'showing records the three-minute cooldown');
  }
  assert.notEqual(copies[80], copies[100], 'the fully hungry request uses its stronger plea');
});

test('physical mouse, both touch contacts and care keys must all be released before the full safe gap', async t => {
  for (const input of ['mouse', 'touch', ' ', 'Enter']) {
    const g = await game(t); prepare(g);
    const p = g.state('state.pimples[0]'), canvas = g.d.getElementById('skin-canvas');
    const first = {identifier: 41, clientX: p.x - 25, clientY: p.y};
    const second = {identifier: 42, clientX: p.x + 25, clientY: p.y};
    if (input === 'mouse') g.mouse(canvas, 'mousedown', p.x, p.y);
    else if (input === 'touch') g.touch('touchstart', [first, second]);
    else { canvas.focus(); key(g, input); }
    // Completing an extraction or changing tools can release logical input
    // before the physical contact ends. A reminder must still wait for the hand.
    g.evaluate('releasePointer();');
    g.clock.advance(15000);
    assert.equal(open(g), false, `${JSON.stringify(input)}: no timer can interrupt a physically held action`);
    assert.equal(g.state('maybeShowHungerReminder()'), false);
    if (input === 'touch') {
      g.touch('touchend', [first], [second]);
      g.clock.advance(2000);
      assert.equal(open(g), false, 'lifting one finger does not create a safe pause');
      const third = {...second, identifier: 43};
      g.touch('touchstart', [first, third], [third]);
      g.clock.advance(2000);
      assert.equal(open(g), false, 'replacing one finger while another remains down cannot reopen reminders');
      g.touch('touchend', [], [first, third]);
    } else if (input === 'mouse') g.mouse(canvas, 'mouseup', p.x, p.y);
    else key(g, input, 'keyup');
    g.clock.advance(1399);
    assert.equal(open(g), false, 'the release delay is a full 1.4 seconds');
    if (input === 'mouse') {
      g.mouse(canvas, 'mousedown', p.x, p.y);
      g.clock.advance(1);
      assert.equal(open(g), false, 'a fresh press cancels the earlier release deadline');
      g.mouse(canvas, 'mouseup', p.x, p.y);
      g.clock.advance(1399);
      assert.equal(open(g), false);
    }
    g.clock.advance(1); await tick();
    assert.equal(open(g), true, `${JSON.stringify(input)}: the first complete quiet interval can show the request`);
  }
});

test('other dialogs, visible gifts, ice, completed care and hidden pages keep their screen and do not spend the reminder', async t => {
  const guards = [
    ['help dialog', g => g.click('btn-help')],
    ['gift notice', g => g.evaluate('showGiftNotice(rewardItem("food_pudding"));')],
    ['ice finish', g => g.evaluate('state.iceFinishing=true;')],
    ['ice brushing', g => g.evaluate('state.iceBrushingMode=true;')],
    ['completed care', g => g.evaluate('state.settled=true;')],
    ['background', g => {
      Object.defineProperty(g.d, 'hidden', {configurable: true, value: true});
      Object.defineProperty(g.d, 'visibilityState', {configurable: true, value: 'hidden'});
      g.d.dispatchEvent(new g.w.Event('visibilitychange'));
    }]
  ];
  for (const [name, guard] of guards) {
    const g = await game(t); prepare(g); g.clock.advance(1500);
    guard(g); await tick();
    const before = plain(g.state('wardrobeProgress'));
    const active = g.d.querySelector('.modal-backdrop.open')?.id || null;
    assert.equal(g.state('maybeShowHungerReminder()'), false, name);
    g.evaluate('queueHungerReminder(0);'); g.clock.advance(0); await tick();
    assert.equal(open(g), false, name + ' is not covered');
    assert.equal(g.d.querySelector('.modal-backdrop.open')?.id || null, active);
    assert.deepEqual(plain(g.state('wardrobeProgress')), before, 'a blocked candidate is not treated as a displayed reminder');
  }
});

test('the request opens the real food shelf, consumes nothing at entry, and a real meal resets the pause before a later round', async t => {
  const g = await game(t); prepare(g); await show(g);
  const run = g.state('state.runId'), before = plain(g.state('wardrobeProgress'));
  g.click('btn-hunger-feed'); await tick();
  assert.equal(open(g), false);
  assert.equal(g.d.getElementById('wardrobe-modal').classList.contains('open'), true);
  assert.equal(g.d.getElementById('wardrobe-food-panel').hidden, false);
  assert.equal(g.d.getElementById('wardrobe-tab-food').getAttribute('aria-selected'), 'true');
  assert.deepEqual(plain(g.state('wardrobeProgress.pantry')), before.pantry);
  assert.equal(g.state('wardrobeProgress.hunger'), 100, 'the reminder button is navigation, not a meal');
  const satiety = g.state('FOOD_ITEMS.find(item=>item.id==="food_pudding").satiety');
  g.d.querySelector('#wardrobe-food-collection [data-feed="food_pudding"]').click();
  await tick();
  assert.equal(g.state('wardrobeProgress.pantry.food_pudding'), 1);
  assert.equal(g.state('wardrobeProgress.hunger'), 100 - satiety);
  assert.match(g.d.getElementById('wardrobe-status').textContent, /谢谢你的款待/);
  const fedAt = g.clock.now(), profile = read(g);
  assert.equal(profile.wardrobe.pantry.food_pudding, 1);
  assert.equal(profile.wardrobe.hunger, 100 - satiety);
  assert.equal(profile.wardrobe.hungerReminder.nextAt, fedAt + 5 * 60 * 1000);
  g.click('btn-close-wardrobe'); await tick();
  assert.equal(g.d.querySelector('.modal-backdrop.open'), null, 'closing the food shelf returns to care');
  assert.equal(g.state('state.paused'), false);
  assert.equal(g.state('state.runId'), run);
  // Complete this care through the real ice/settlement boundary. Its +12
  // hunger makes another request eligible, but does not skip the meal cooldown.
  g.evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  g.click('btn-ice-quick'); g.frame(65);
  assert.equal(g.state('state.settled'), true);
  assert.equal(g.state('wardrobeProgress.hunger'), 100 - satiety + 12);
  g.click('btn-next-face'); await tick();
  assert.notEqual(g.state('state.runId'), run);
  g.clock.advance(5 * 60 * 1000 - 1);
  assert.equal(open(g), false, 'the next round cannot bypass the meal cooldown');
  g.clock.advance(1);
  g.evaluate('queueHungerReminder(0);'); g.clock.advance(0); await tick();
  assert.equal(open(g), true, 'a later hungry round can ask again after the meal cooldown');
  assert.equal(g.state('wardrobeProgress.pantry.food_pudding'), 1);
});

test('closing persists its cooldown across refresh, and a saved run cannot ask twice even long afterward', async t => {
  const g = await game(t); prepare(g); await show(g);
  const run = g.state('state.runId');
  g.click('btn-hunger-later'); await tick();
  assert.equal(open(g), false);
  assert.equal(read(g).wardrobe.hungerReminder.nextAt, g.clock.now() + 5 * 60 * 1000);
  g.evaluate('saveCurrentSession(true);');
  const storage = g.storage(), now = g.clock.now(); g.close();
  const restored = await game(t, {storage, now});
  assert.equal(restored.state('state.runId'), run, 'refresh resumes the run that already showed its request');
  restored.clock.advance(10 * 60 * 1000);
  restored.evaluate('queueHungerReminder(0);'); restored.clock.advance(0);
  assert.equal(open(restored), false, 'the same run does not ask again after the timestamp expires');
  assert.equal(restored.state('maybeShowHungerReminder()'), false);
  prepare(restored, {resetReminder: false, level: 7});
  assert.notEqual(restored.state('state.runId'), run);
  await show(restored);
  assert.equal(read(restored).wardrobe.hungerReminder.lastRunId, restored.state('state.runId'));
});

test('all close controls, Escape and the backdrop restore focus and allow care without an immediate repeat', async t => {
  for (const method of ['close', 'later', 'Escape', 'backdrop']) {
    const g = await game(t); prepare(g);
    const canvas = g.d.getElementById('skin-canvas'); canvas.focus();
    await show(g);
    const modal = g.d.getElementById('hunger-modal');
    assert.equal(modal.getAttribute('role'), 'dialog');
    assert.equal(modal.getAttribute('aria-modal'), 'true');
    assert.ok(modal.contains(g.d.activeElement), 'focus enters the request');
    const controls = [...modal.querySelectorAll('button:not([disabled])')].filter(button=>button.getClientRects().length);
    controls.at(-1).focus(); key(g, 'Tab', 'keydown', g.d.activeElement);
    assert.equal(g.d.activeElement, controls[0], 'Tab wraps inside the dialog');
    key(g, 'Tab', 'keydown', g.d.activeElement, {shiftKey: true});
    assert.equal(g.d.activeElement, controls.at(-1));
    modal.querySelector('.hunger-card').click();
    assert.equal(open(g), true, 'clicking the card does not act like clicking its backdrop');
    if (method === 'Escape') key(g, 'Escape', 'keydown', g.d.activeElement);
    else g.click(method === 'close' ? 'btn-close-hunger' : method === 'later' ? 'btn-hunger-later' : 'hunger-modal');
    await tick();
    assert.equal(open(g), false, method);
    assert.equal(g.state('state.paused'), false);
    assert.equal(g.d.activeElement, canvas, method + ' returns focus to the current care');
    g.clock.advance(10 * 60 * 1000);
    assert.equal(open(g), false, 'dismissal does not create a repeating prompt loop');
    assert.equal(g.state('wardrobeProgress.pantry.food_pudding'), 2);
  }
});

test('a page without the care lock cannot show a request or consume the active page food', async t => {
  const hub = createStorageHub({}, {autoFlush: false});
  const owner = await game(t, {storageHub: hub}); prepare(owner);
  owner.evaluate('persistSaveData();saveCurrentSession(true);');
  const waiting = await game(t, {storageHub: hub});
  assert.equal(waiting.state('careControl.owned'), false);
  const before = hub.snapshot()[PROFILE];
  waiting.clock.advance(5 * 60 * 1000);
  assert.equal(waiting.state('maybeShowHungerReminder()'), false);
  waiting.evaluate('queueHungerReminder(0);'); waiting.clock.advance(0);
  assert.equal(open(waiting), false);
  assert.equal(waiting.d.getElementById('storage-gate-modal').classList.contains('open'), true);
  assert.equal(waiting.state('feedGirl("food_pudding")'), false);
  assert.equal(hub.snapshot()[PROFILE], before);
  assert.equal(owner.state('wardrobeProgress.pantry.food_pudding'), 2);
});
