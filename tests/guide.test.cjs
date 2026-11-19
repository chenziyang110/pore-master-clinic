const test=require('node:test');
const assert=require('node:assert/strict');
const {createGame}=require('./harness.cjs');

test('the first guide teaches only the simple blackhead route with legal next-tool advice',async t=>{
  const g=await createGame({seed:12});t.after(g.close);g.frame();
  assert.deepEqual(JSON.parse(g.state('JSON.stringify(state.practiceGuide.ids.map(id=>state.pimples.find(p=>p.id===id).type))')),['blackhead']);
  assert.equal(g.d.getElementById('practice-guide').hidden,false);
  assert.match(g.d.getElementById('practice-label').textContent,/黑头/);
  // Isolate instructional state transitions; extraction mechanics have their own tests.
  g.evaluate('getPracticeTarget().steamed=1;updateHUD();');
  assert.equal(g.d.getElementById('btn-care-next').dataset.tool,'tweezers');
  g.click('btn-care-next');assert.equal(g.state('state.currentTool'),'tweezers');
  g.evaluate('getPracticeTarget().state=P_STATE.HEALING;updateHUD();');
  assert.equal(g.state('state.practiceGuide.step'),1);
  assert.equal(g.state('state.practiceGuide.active'),false);
  assert.equal(g.d.getElementById('practice-guide').hidden,true);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('skip persists without changing the treatment and help can resume the guide',async t=>{
  let g=await createGame({seed:13});t.after(()=>g.close());g.frame();
  const before=g.state('JSON.stringify(state.pimples)');g.click('btn-skip-practice');
  assert.equal(g.state('JSON.stringify(state.pimples)'),before);
  assert.equal(g.d.getElementById('practice-guide').hidden,true);
  const saved=g.storage();g.close();g=await createGame({storage:saved});g.frame();
  assert.equal(g.state('state.practiceGuide.active'),false);
  g.click('btn-help');g.click('btn-replay-practice');
  assert.equal(g.state('state.practiceGuide.active'),true);
  assert.equal(g.d.getElementById('help-modal').classList.contains('open'),false);
  assert.deepEqual(g.runtimeErrors,[]);
});

