const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

async function game(t, options = {}) {
  const g = await createGame({legacyRecipe:true,seed:61234, ...options});
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  return g;
}

function tap(g, tool, p) {
  g.click(`tool-${tool}`);
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  g.mouse(g.w, 'mouseup', p.x, p.y);
}

function warm(g, p) {
  g.click('tool-steam');
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  g.frame(100);
  g.mouse(g.w, 'mouseup', p.x, p.y);
  assert.ok(p.steamed >= .75);
}

function squeezeOut(g, p) {
  const angle = p.type === 'cyst' ? p.targetAngle : 0;
  const start = p.type === 'cyst' ? 48 : 38;
  g.click('tool-squeeze');
  g.mouse('skin-canvas', 'mousedown', p.x+Math.cos(angle)*start, p.y+Math.sin(angle)*start);
  g.mouse(g.w, 'mousemove', p.x+Math.cos(angle)*(start-10), p.y+Math.sin(angle)*(start-10));
  // Feed the ordinary simulation after real input; stop at extraction so the
  // test never adds an unrelated over-squeeze after the target is already empty.
  g.evaluate(`for(let i=0;i<1000&&state.pimples.find(p=>p.id===${p.id}).state!==P_STATE.OOZING;i++)updateSimulation(.02);`);
  g.mouse(g.w, 'mouseup', p.x+Math.cos(angle)*(start-10), p.y+Math.sin(angle)*(start-10));
  assert.equal(p.state, 3);
  assert.equal(g.state('state.runStats.mistakes'), 0);
}

test('skipped or completed teaching starts a fresh mixed board with heat and an actionable target', async t => {
  for (const guide of ['skipped','completed']) {
    const g = await game(t, {storage:{pimple_clinic_guide_v1:guide}});
    const next = g.d.getElementById('btn-care-next');
    assert.equal(g.state('currentPointerCareTarget()'), null);
    assert.equal(g.state('state.pimples.some(p=>p.type==="cyst"&&!p.pierced)'), true);
    assert.equal(next.dataset.tool, 'steam');
    assert.equal(next.hidden, false, 'an unselected target can be located even with the right tool equipped');
    assert.match(next.textContent, /下一处：先热敷/);
    assert.match(next.title, /黑头.*先热敷/);
    const target = next.careTarget.item;
    const serial = g.state('state.actionSerial'), score = g.state('state.score');
    if (guide === 'skipped') {
      g.mouse(next, 'mousedown', 0, g.state('state.height')+20);
      g.mouse(g.w, 'mouseup', 0, g.state('state.height')+20);
    } else {
      const touch = {identifier:82,clientX:0,clientY:g.state('state.height')+20};
      for (const type of ['touchstart','touchend']) {
        const event = new g.w.Event(type, {bubbles:true,cancelable:true});
        Object.defineProperties(event, {touches:{value:type==='touchstart'?[touch]:[]},changedTouches:{value:[touch]}});
        next.dispatchEvent(event);
      }
    }
    g.click('btn-care-next');
    assert.equal(g.state('currentPointerCareTarget().item.id'), target.id);
    assert.equal(g.state('state.pointer.hoverX'), target.x);
    assert.equal(g.state('state.pointer.hoverY'), target.y);
    assert.equal(g.state('state.pointer.active'), false);
    assert.equal(g.state('state.runControlMode'), 'pointer');
    assert.equal(g.state('state.actionSerial'), serial);
    assert.equal(g.state('state.score'), score);
    assert.match(g.d.getElementById('hint-banner').textContent, /先照顾.*黑头/);
    assert.equal(target.steamed, 0, 'locating a target never performs the treatment');

    const deep = g.state('state.pimples.find(p=>p.type==="cyst")');
    g.mouse(g.w, 'mousemove', deep.x, deep.y);
    assert.equal(next.dataset.tool, 'needle', 'the deliberate deep-target choice takes precedence over the global heat start');
    g.click('btn-care-next');
    assert.equal(g.state('state.currentTool'), 'needle');
    assert.equal(g.state('currentPointerCareTarget().item.id'), deep.id);
  }
});

test('the first guide keeps the heat goal after loosening a cold blackhead while direct grabbing stays legal', async t => {
  const g = await game(t);
  const p = g.state('getPracticeTarget()');
  tap(g, 'needle', p);
  const next = g.d.getElementById('btn-care-next');
  assert.equal(p.pierced, true);
  assert.equal(next.dataset.tool, 'steam');
  assert.match(g.d.getElementById('practice-label').textContent, /按住圈内热敷/);
  assert.match(g.d.getElementById('hint-banner').textContent, /本次目标.*先充分热敷/);
  g.click('tool-tweezers');
  assert.match(g.d.getElementById('hint-banner').textContent, /可以夹取.*本次目标.*先充分热敷/);
  g.mouse('skin-canvas', 'mousedown', p.x, p.y);
  assert.equal(g.state('state.tweezers.clampedPimple.id'), p.id);
  g.mouse(g.w, 'mouseup', p.x, p.y);
  warm(g, p);
  assert.equal(next.dataset.tool, 'tweezers');
  assert.match(g.d.getElementById('practice-label').textContent, /慢慢拉出/);
  assert.equal(g.state('state.runStats.mistakes'), 0);
});

test('real squeeze-then-collect paths preserve goal progress and extraction quality through both collection tools', async t => {
  for (const type of ['blackhead','cyst']) for (const collectWith of ['tweezers','swab']) {
    const g = await game(t);
    g.click('btn-skip-practice');
    if (type === 'cyst') {
      g.click('btn-clinic');
      g.d.querySelectorAll('#client-list-container .client-card')[2].click();
    }
    const p = g.state(`state.pimples.find(p=>p.type===${JSON.stringify(type)})`);
    warm(g, p);
    if (type === 'cyst') tap(g, 'needle', p);
    squeezeOut(g, p);
    const residue = g.state(`state.surfaceResidues.find(r=>r.pimpleId===${p.id}&&['worm','core_seed'].includes(r.kind))`);
    assert.ok(residue);
    const id = residue.collectionId;
    const before = JSON.parse(g.state(`JSON.stringify(state.collectionLedger[${JSON.stringify(id)}])`));
    const progress = g.state('evaluateCareGoal().progress');
    assert.match(progress, /^1 \/ /);
    assert.equal(before.location, 'skin');
    assert.equal(before.sourceType, type);
    assert.equal(before.softened, true);
    assert.equal(before.gentle, true);
    if (type === 'cyst') assert.equal(before.pierced, true);

    if (collectWith === 'tweezers') tap(g, collectWith, residue);
    else for (let i=0;i<8;i++) tap(g, collectWith, p);
    g.frame(32);
    const after = g.state(`state.collectionLedger[${JSON.stringify(id)}]`);
    assert.equal(after.location, 'tray');
    for (const key of ['sourceType','softened','pierced','gentle']) assert.equal(after[key], before[key], `${type}/${collectWith}: ${key}`);
    assert.equal(g.state('evaluateCareGoal().progress'), progress, 'collecting an earned extraction cannot undo its goal progress');
    assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'), 1);
    g.w.dispatchEvent(new g.w.Event('pagehide'));
    const resumed = await game(t, {storage:g.storage()});
    assert.equal(resumed.state('evaluateCareGoal().progress'), progress);
    assert.equal(resumed.state('state.trophiesPlucked+state.coreSeedsCollected'), 1);
  }
});

