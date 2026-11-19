const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

const tick = () => new Promise(setImmediate);
const text = (g, id) => g.d.getElementById(id).textContent;
function key(g, value) {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent('keydown', {key:value, bubbles:true, cancelable:true}));
}

test('current goal has a direct entry and keeps its progress separate from journey stamps', async t => {
  const g = await createGame({seed:201}); t.after(g.close); g.frame();
  const entry = g.d.getElementById('btn-plan');
  assert.equal(g.d.querySelectorAll('#btn-plan').length, 1);
  assert.equal(entry.closest('.case-foot'), null, 'goal entry is outside the region hidden on phones');
  assert.equal(entry.parentElement.getAttribute('aria-label'), '本次护理记录');
  assert.equal(g.d.getElementById('care-journal-count').closest('#plan-modal')?.id, 'plan-modal');
  assert.equal(text(g, 'care-goal-entry-title'), '先软化再取出');
  assert.equal(text(g, 'care-goal-entry-progress'), '0/5 处');

  g.evaluate(`state.collectionLedger = Object.fromEntries(state.pimples.filter(p=>p.type==='blackhead').slice(0,2)
    .map(p=>['fixture-'+p.id,{sourceType:p.type,softened:true,rewards:{extract:true}}]));
    updateCareGuidance();
    careRecords.bests[careModeKey('student',0,'pointer')]={clientId:'student',density:0,inputMode:'pointer',bestScore:100,bestGrade:'S',completions:1,goalMet:true};
    updateCareJourneySummary();`);
  assert.equal(text(g, 'care-goal-entry-progress'), '2/5 处');
  assert.equal(text(g, 'care-journal-count'), '1/5');
  assert.match(entry.getAttribute('aria-label'), /本次目标：先软化再取出.*2 \/ 5 处先软化.*查看目标详情/);

  entry.focus(); entry.click(); await tick();
  assert.ok(g.d.getElementById('plan-modal').classList.contains('open'));
  assert.match(text(g, 'care-goal-current'), /每一处黑头.*2 \/ 5/);
  assert.match(text(g, 'plan-title'), /印记 1\/5/);
  g.click('btn-close-plan'); await tick();
  assert.equal(g.d.activeElement, entry, 'closing the existing notes returns to the visible goal entry');

  for (let client = 1; client < 5; client++) {
    g.evaluate(`state.clientIndex=${client};generateLevel();`);
    assert.equal(text(g, 'care-goal-entry-title'), g.state('evaluateCareGoal().title'));
    assert.ok(text(g, 'care-goal-entry-progress').length > 0);
    assert.ok(entry.getAttribute('aria-label').includes(g.state('evaluateCareGoal().progress')));
    assert.equal(text(g, 'care-journal-count'), '1/5');
  }
  assert.deepEqual(g.runtimeErrors, []);
});

test('keyboard treatment numbering stays at eight or eleven when residues and splatters are selectable', async t => {
  for (const density of [8, 11]) {
    const g = await createGame({seed:202 + density}); t.after(g.close); g.frame();
    g.evaluate(`generateLevel(${density});
      state.surfaceResidues=Array.from({length:36},(_,i)=>({kind:'pus',x:50+i*3,y:100,r:2,alpha:1}));
      state.lensSplatters=[{x:120,y:120,r:2,alpha:1,color:'#eeddbb',subDrops:[]},{x:140,y:120,r:2,alpha:1,color:'#eeddbb',subDrops:[]}];`);
    const canvas = g.d.getElementById('skin-canvas'); canvas.focus();
    for (let i = 1; i < density; i++) key(g, 'ArrowRight');
    for (const tool of ['5', '4', '1', '5']) {
      key(g, tool);
      assert.match(text(g, 'keyboard-care-status'), new RegExp(`护理点 ${density}/${density} ·`));
      assert.match(canvas.getAttribute('aria-label'), new RegExp(`护理点 ${density}/${density} ·`));
    }
    key(g, 'ArrowRight');
    assert.match(text(g, 'keyboard-care-status'), /表面残留 1\/36$/);
    assert.equal(g.state('currentKeyboardTarget().kind'), 'residue');
    for (let i = 1; i < 36; i++) key(g, 'ArrowRight');
    assert.match(text(g, 'keyboard-care-status'), /表面残留 36\/36$/);
    key(g, 'ArrowRight');
    assert.match(text(g, 'keyboard-care-status'), /镜面飞溅 1\/2$/);
    key(g, 'ArrowRight');
    assert.match(canvas.getAttribute('aria-label'), /镜面飞溅 2\/2$/);
    key(g, 'ArrowRight');
    assert.match(text(g, 'keyboard-care-status'), new RegExp(`护理点 1/${density} ·`));
    assert.equal(g.state('currentKeyboardTarget().kind'), 'pimple');
    assert.deepEqual(g.runtimeErrors, []);
  }
});
