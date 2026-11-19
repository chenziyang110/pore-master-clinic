const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

const tick = () => new Promise(setImmediate);
const text = (g, id) => g.d.getElementById(id).textContent;
function key(g, value) {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent('keydown', {key:value, bubbles:true, cancelable:true}));
}

test('legacy goal progress stays independent from the simplified level header', async t => {
  const g = await createGame({legacyRecipe:true,seed:201});t.after(g.close);g.frame();
  assert.equal(text(g,'current-level'),'第 1 关');
  assert.ok(g.d.getElementById('btn-plan').closest('[hidden]'));
  g.evaluate(`state.collectionLedger=Object.fromEntries(state.pimples.filter(p=>p.type==='blackhead').slice(0,2)
    .map(p=>['fixture-'+p.id,{sourceType:p.type,softened:true,rewards:{extract:true}}]));
    careRecords.bests[careModeKey('student',0,'pointer')]={clientId:'student',density:0,inputMode:'pointer',bestScore:100,bestGrade:'S',completions:1,goalMet:true};
    updateHUD();`);
  assert.match(g.state('evaluateCareGoal().progress'),/2 \/ 5/);
  assert.equal(g.state('getCareJourney().count'),1);
  assert.equal(text(g,'current-level'),'第 1 关');
  assert.equal(g.state('wardrobeProgress.level'),1);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('keyboard treatment numbering stays at eight or eleven when residues and splatters are selectable', async t => {
  for (const density of [8, 11]) {
    const g = await createGame({legacyRecipe:true,seed:202 + density}); t.after(g.close); g.frame();
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

