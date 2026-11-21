const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');
const {setupRound} = require('./round-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));

function clockFor(window) {
  const nativeClear = window.clearTimeout.bind(window), tasks = new Map();
  let now = 0, nextId = 100000;
  window.setTimeout = (callback, delay = 0, ...args) => {
    const id = nextId++;
    tasks.set(id, {callback: () => callback(...args), at: now + Math.max(0, Number(delay) || 0)});
    return id;
  };
  window.clearTimeout = id => { if (!tasks.delete(id)) nativeClear(id); };
  return {
    callback: id => tasks.get(id)?.callback,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, task] = next;
        now = task.at; tasks.delete(id); task.callback();
      }
      now = target;
    }
  };
}

async function game(t, {pointer = true, reducedMotion = false} = {}) {
  const g = await createGame({seed: 28, setupWindow(w) {
    w.PointerEvent = pointer ? w.MouseEvent : undefined;
    if (reducedMotion) w.matchMedia = query => ({matches: query.includes('prefers-reduced-motion'), media: query,
      addEventListener() {}, removeEventListener() {}});
  }});
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  setupRound(g, {level: 4});
  g.clock = clockFor(g.w);
  g.notice = g.d.getElementById('gift-discovery');
  return g;
}

function reveal(g, id = 'food_strawberry_cake', index = 0) {
  g.evaluate(`state.pimples[${index}].giftId=${JSON.stringify(id)};
    state.initialPimples[${index}].giftId=${JSON.stringify(id)};
    state.pimples[${index}].state=P_STATE.OOZING;revealWardrobeFind(state.pimples[${index}]);`);
}

function pointer(g, type, x, y, id = 1) {
  const event = new g.w.Event(type, {bubbles: true, cancelable: true});
  Object.defineProperties(event, {clientX: {value: x}, clientY: {value: y}, button: {value: 0},
    pointerId: {value: id}, isPrimary: {value: true}});
  g.notice.dispatchEvent(event);
}

function touch(g, type, x, y) {
  const point = {identifier: 5, clientX: x, clientY: y};
  const event = new g.w.Event(type, {bubbles: true, cancelable: true});
  Object.defineProperties(event, {touches: {value: type === 'touchend' ? [] : [point]}, changedTouches: {value: [point]}});
  g.notice.dispatchEvent(event);
}

test('discovery dismisses automatically without losing or prematurely awarding the gift', async t => {
  const g = await game(t);
  reveal(g);
  assert.equal(g.notice.hidden, false);
  assert.match(g.notice.textContent, /草莓小蛋糕.*过关带回家/);
  assert.ok(g.notice.querySelector('button[aria-label="关闭礼物提示"]'));
  assert.ok(g.notice.querySelector('[role="status"][aria-live="polite"]'));
  g.clock.advance(2799);
  assert.equal(g.notice.hidden, false);
  g.clock.advance(181);
  assert.equal(g.notice.hidden, true);
  assert.deepEqual(plain(g.state('state.discoveredGifts')), ['food_strawberry_cake']);
  assert.equal(g.state('wardrobeProgress.pantry.food_strawberry_cake'), undefined);
  g.evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  g.click('btn-ice-quick'); g.frame(65);
  assert.equal(g.state('state.settled'), true);
  assert.equal(g.state('wardrobeProgress.pantry.food_strawberry_cake'), 1);
});

test('upward swipe follows the finger and dismisses without starting a canvas action', async t => {
  const g = await game(t);
  reveal(g);
  const before = plain(g.state('state.pimples'));
  pointer(g, 'pointerdown', 150, 100);
  pointer(g, 'pointermove', 153, 53);
  assert.equal(g.notice.style.getPropertyValue('--gift-drag-y'), '-47px');
  assert.equal(g.state('state.pointer.active'), false);
  pointer(g, 'pointerup', 153, 53);
  assert.equal(g.notice.classList.contains('is-dismissing'), true);
  g.clock.advance(180);
  assert.equal(g.notice.hidden, true);
  assert.equal(g.state('giftNoticeGesture'), null);
  assert.deepEqual(plain(g.state('state.pimples')), before);
});

test('horizontal motion, short drags and cancelled pointers snap back; touch fallback also closes upward', async t => {
  const g = await game(t);
  reveal(g);
  for (const [dx, dy, ending] of [[60, -35, 'pointerup'], [0, -12, 'pointerup'], [0, -70, 'pointercancel']]) {
    pointer(g, 'pointerdown', 100, 100);
    pointer(g, 'pointermove', 100 + dx, 100 + dy);
    pointer(g, ending, 100 + dx, 100 + dy);
    assert.equal(g.notice.hidden, false);
    assert.equal(g.notice.classList.contains('is-dismissing'), false);
    assert.equal(g.notice.style.getPropertyValue('--gift-drag-y'), '');
  }
  const fallback = await game(t, {pointer: false});
  reveal(fallback);
  touch(fallback, 'touchstart', 100, 100);
  touch(fallback, 'touchmove', 102, 48);
  touch(fallback, 'touchend', 102, 48);
  fallback.clock.advance(180);
  assert.equal(fallback.notice.hidden, true);
});

test('a later reward replaces stale timers and quickly found rewards share one notice', async t => {
  const g = await game(t);
  reveal(g);
  const staleAuto = g.clock.callback(g.state('giftNoticeTimer'));
  g.clock.advance(2200);
  reveal(g, 'bow_rose', 1);
  staleAuto();
  assert.equal(g.notice.classList.contains('is-dismissing'), false);
  assert.match(g.notice.textContent, /草莓小蛋糕、莓果蝴蝶结/);
  g.notice.querySelector('button').click();
  const staleExit = g.clock.callback(g.state('giftNoticeTimer'));
  reveal(g, 'food_honey_toast', 2);
  staleExit();
  assert.equal(g.notice.hidden, false);
  assert.match(g.notice.textContent, /蜂蜜吐司/);
  assert.doesNotMatch(g.notice.textContent, /草莓小蛋糕/);
  g.clock.advance(2980);
  assert.equal(g.notice.hidden, true);
  assert.deepEqual(plain(g.state('state.discoveredGifts')), ['food_strawberry_cake', 'bow_rose', 'food_honey_toast']);
});

test('keyboard dismissal restores canvas focus and reduced motion hides immediately', async t => {
  const g = await game(t);
  reveal(g);
  g.notice.querySelector('button').focus();
  g.clock.advance(5000);
  assert.equal(g.notice.hidden, false, 'keyboard readers control the focused notice');
  g.notice.querySelector('button').dispatchEvent(new g.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
  g.clock.advance(180);
  assert.equal(g.notice.hidden, true);
  assert.equal(g.d.activeElement.id, 'skin-canvas');
  const reduced = await game(t, {reducedMotion: true});
  reveal(reduced);
  pointer(reduced, 'pointerdown', 100, 100);
  pointer(reduced, 'pointermove', 100, 50);
  assert.equal(reduced.notice.style.getPropertyValue('--gift-drag-y'), '');
  pointer(reduced, 'pointerup', 100, 50);
  assert.equal(reduced.notice.hidden, true);
});

test('home, wardrobe, backgrounding and next round cancel pending notices and gift flights', async t => {
  for (const action of ['showAdventureHome()', 'openWardrobe()', 'window.dispatchEvent(new Event("blur"))', 'generateLevel(0)']) {
    const g = await game(t);
    reveal(g);
    const stale = g.clock.callback(g.state('giftNoticeTimer'));
    g.evaluate(action);
    stale(); g.clock.advance(5000);
    assert.equal(g.notice.hidden, true, action);
    assert.equal(g.d.getElementById('gift-flight-layer').childElementCount, 0, action);
    assert.equal(g.state('giftNoticeTimer'), null, action);
  }
});
