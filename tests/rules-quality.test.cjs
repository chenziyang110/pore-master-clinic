const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

async function gameFor(t, options = {}) {
  const g = await createGame({seed:43, ...options});
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  g.click('btn-skip-practice');
  return g;
}

function point(g, type) { return g.state(`state.pimples.find(p => p.type === ${JSON.stringify(type)})`); }
function needle(g, p) {
  g.click('tool-needle');
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  g.mouse(g.w, 'mouseup', p.x, p.y);
}
function nextTool(g) { return g.d.getElementById('btn-care-next').dataset.tool; }
function hint(g) { return g.d.getElementById('hint-banner').textContent; }

test('the pierced whitehead route explains exposure before grabbing and accepts it after real gentle squeezing', async t => {
  const g = await gameFor(t), p = point(g, 'whitehead');
  needle(g, p);
  assert.equal(p.pierced, true);
  assert.equal(p.state, 0, 'a needle opens the skin but does not expose the core');
  g.click('tool-tweezers');
  assert.match(hint(g), /已挑开.*先轻挤到露头/);
  assert.equal(nextTool(g), 'squeeze');
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  assert.equal(g.state('state.tweezers.clampedPimple'), null);
  assert.match(hint(g), /已挑开.*先轻挤到露头/);
  g.mouse(g.w, 'mouseup', p.x, p.y);

  g.click('btn-care-next');
  g.mouse('skin-canvas', 'mousedown', p.x + 38, p.y);
  g.mouse(g.w, 'mousemove', p.x + 28, p.y);
  let frames = 0;
  while (p.state < 2 && frames++ < 300) g.frame();
  assert.equal(p.state, 2);
  g.mouse(g.w, 'mouseup', p.x + 28, p.y);
  g.click('tool-tweezers');
  assert.match(hint(g), /已露头/);
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  assert.equal(g.state('state.tweezers.clampedPimple.id'), p.id);
  assert.equal(g.state('state.runStats.mistakes'), 0);
  g.mouse(g.w, 'mouseup', p.x, p.y);
  assert.match(g.d.querySelector('[data-tool-guidance="tweezers"]').textContent, /白头与深层先轻挤到露头/);
});

test('mouse guidance follows the hovered site and retains that context when changing tools', async t => {
  const g = await gameFor(t), black = point(g, 'blackhead'), white = point(g, 'whitehead'), deep = point(g, 'cyst');
  black.steamed = 1; white.pierced = true;
  g.click('tool-swab');
  for (const [p, expected] of [[black, 'tweezers'], [white, 'squeeze'], [deep, 'needle']]) {
    g.mouse(g.w, 'mousemove', p.x, p.y);
    assert.equal(nextTool(g), expected);
    assert.match(g.d.getElementById('btn-care-next').textContent, /^这处：/);
    g.click('btn-care-next');
    assert.equal(g.state('state.currentTool'), expected);
    assert.equal(g.state('currentPointerCareTarget().item.id'), p.id);
    g.click('tool-swab');
  }
  g.mouse(g.w, 'mousemove', 0, 0);
  assert.equal(g.state('currentPointerCareTarget()'), null);
  assert.match(g.d.getElementById('btn-care-next').textContent, /^下一处：/);
});

test('touch guidance follows the primary site, ignores other fingers and is not part of saved care', async t => {
  const g = await gameFor(t), p = point(g, 'cyst'), other = point(g, 'whitehead');
  g.click('tool-needle');
  const main = {identifier:12, clientX:p.x, clientY:p.y};
  const foreign = {identifier:29, clientX:other.x, clientY:other.y};
  g.touch('touchstart', [main], [main]);
  g.touch('touchstart', [foreign, main], [foreign]);
  g.touch('touchmove', [foreign, main], [foreign]);
  assert.equal(g.state('currentPointerCareTarget().item.id'), p.id);
  g.touch('touchend', [main], [foreign]);
  assert.equal(p.pierced, false);
  g.touch('touchend', [], [main]);
  g.click('tool-tweezers');
  assert.match(hint(g), /已挑开.*先轻挤到露头/);
  assert.equal(nextTool(g), 'squeeze');
  const stored = g.storage();
  const profile = JSON.parse(stored.pimple_clinic_profile_v3);
  assert.equal('pointerCareTarget' in profile.session.data, false);
  const resumed = await gameFor(t, {storage:stored});
  assert.equal(resumed.state('currentPointerCareTarget()'), null);
  g.evaluate('generateLevel(8);');
  assert.equal(g.state('currentPointerCareTarget()'), null);
});

test('two-finger guidance follows the captured site even when the midpoint is outside its hover radius', async t => {
  const g = await gameFor(t);
  // A ready blackhead makes the whole-board suggestion differ from both
  // targets in the gesture. The gesture itself uses the normal touch path.
  g.evaluate(`
    state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});
    Object.assign(state.pimples.find(p=>p.type==='whitehead'), {state:P_STATE.INTACT,x:120,y:220,pierced:true});
    Object.assign(state.pimples.find(p=>p.type==='cyst'), {state:P_STATE.INTACT,x:260,y:130,pierced:false});
    Object.assign(state.pimples.find(p=>p.type==='blackhead'), {state:P_STATE.INTACT,x:320,y:420,steamed:1});
    updateHUD();
  `);
  g.click('tool-squeeze');
  const first = {identifier:21,clientX:140,clientY:260};
  const second = {identifier:22,clientX:180,clientY:260};
  g.touch('touchstart', [first], [first]);
  g.touch('touchstart', [first,second], [second]);
  assert.equal(g.state('state.pointer.lockedPimple.type'), 'whitehead');
  assert.equal(nextTool(g), 'squeeze');
  assert.equal(g.d.getElementById('btn-care-next').hidden, true, 'the selected tool already suits this whitehead');

  const movedFirst = {...first,clientX:280,clientY:170};
  const movedSecond = {...second,clientX:320,clientY:170};
  g.touch('touchmove', [movedFirst,movedSecond], [movedFirst,movedSecond]);
  assert.equal(g.state('state.pointer.lockedPimple.type'), 'cyst');
  assert.equal(nextTool(g), 'needle');
  assert.match(g.d.getElementById('btn-care-next').textContent, /^这处：用粉刺针/);
  assert.match(hint(g), /这处深层先用粉刺针破口/);
  g.touch('touchend', [], [movedFirst,movedSecond]);
  g.click('btn-care-next');
  assert.equal(g.state('state.currentTool'), 'needle');
  assert.equal(g.state('currentPointerCareTarget().item.type'), 'cyst');
});

test('needle release outside any canvas edge cancels for mouse and touch, while an in-board miss still counts', async t => {
  for (const input of ['mouse', 'touch']) {
    const g = await gameFor(t), p = point(g, 'cyst');
    g.click('tool-needle');
    assert.match(hint(g), /移出操作区.*取消/);
    const width = g.state('state.width'), height = g.state('state.height');
    for (const [x,y] of [[-1,p.y],[width,p.y],[p.x,-1],[p.x,height]]) {
      if (input === 'mouse') {
        g.mouse('skin-canvas', 'mousedown', p.x, p.y);
        // A release can arrive without a final mousemove; use its real endpoint.
        g.mouse(g.w, 'mouseup', x, y);
      } else {
        const start={identifier:7,clientX:p.x,clientY:p.y}, end={identifier:7,clientX:x,clientY:y};
        g.touch('touchstart', [start], [start]);
        g.touch('touchmove', [end], [end]);
        g.touch('touchend', [], [end]);
      }
      assert.equal(p.pierced, false);
      assert.equal(g.state('state.pointer.active'), false);
      assert.equal(g.state('state.runStats.mistakes'), 0);
      assert.equal(g.state('state.damage'), 0);
      assert.match(hint(g), /已取消/);
    }
    needle(g, {x:1,y:1});
    assert.equal(g.state('state.runStats.mistakes'), 1);
    assert.ok(g.state('state.damage') > 0);
    needle(g, p);
    assert.equal(p.pierced, true, 'the next correctly aimed needle remains usable');
    assert.equal(g.state('state.runStats.mistakes'), 1);
  }
});

test('Escape cancels an armed pointer needle without firing on its eventual release', async t => {
  const g = await gameFor(t), p = point(g, 'cyst');
  g.click('tool-needle');
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  g.w.dispatchEvent(new g.w.KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}));
  g.mouse(g.w, 'mouseup', p.x, p.y);
  assert.equal(p.pierced, false);
  assert.equal(g.state('state.runStats.mistakes'), 0);
  assert.match(hint(g), /已取消/);
});

test('each customer retains its authored mix at eight and eleven targets across fresh seeds', async t => {
  const g = await gameFor(t);
  const expected = [
    {8:[5,2,1],11:[7,3,1]}, {8:[2,5,1],11:[3,7,1]},
    {8:[2,2,4],11:[3,3,5]}, {8:[4,2,2],11:[5,3,3]}, {8:[8,0,0],11:[11,0,0]}
  ];
  for (let client=0; client<expected.length; client++) for (const count of [8,11]) for (let repeat=0; repeat<2; repeat++) {
    g.evaluate(`state.clientIndex=${client};generateLevel(${count});`);
    const mix = g.state('JSON.stringify(["blackhead","whitehead","cyst"].map(type=>state.pimples.filter(p=>p.type===type).length))');
    assert.deepEqual(JSON.parse(mix), expected[client][count]);
    assert.equal(g.state('state.pimples.length'), count);
  }
  assert.equal(g.d.querySelector('.level-presets').getAttribute('aria-label'), '下一次护理数量');
  assert.doesNotMatch(g.d.querySelector('.level-presets').textContent, /进阶|难度/);
});

test('the actual next-customer controls carry eleven targets into a pure blackhead session', async t => {
  const g = await gameFor(t);
  // The first three stamps are already collected. With this goal history,
  // the next new customer after this care is the blackhead specialist.
  g.evaluate(`for(const client of CLIENTS.slice(0,3))
    careRecords.bests[careModeKey(client.id,0,'pointer')]={clientId:client.id,density:0,inputMode:'pointer',
      bestScore:1000,bestGrade:'S',completions:1,goalMet:true};`);
  g.click('btn-clinic');
  g.d.querySelectorAll('#client-list-container .client-card')[3].click();
  // Only completed cleaning is a fixture; ice, settlement, density and next
  // customer navigation use the same controls as the browser.
  g.evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  g.click('btn-ice-quick');g.frame(65);
  assert.equal(g.state('state.settled'), true);
  g.d.querySelector('.preset-btn[data-density="11"]').click();
  g.click('btn-next-face');
  assert.equal(g.state('state.clientIndex'), 4);
  assert.equal(g.state('state.pimples.length'), 11);
  assert.equal(g.state('state.pimples.every(p=>p.type==="blackhead")'), true);
  assert.equal(g.state('state.runDensity'), 11);
});
