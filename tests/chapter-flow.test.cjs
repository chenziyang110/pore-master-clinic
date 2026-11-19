const test=require('node:test');
const assert=require('node:assert/strict');
const {createGame}=require('./harness.cjs');

function key(g,value,type='keydown') {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent(type,{key:value,bubbles:true,cancelable:true}));
}
function hold(g,seconds,value=' ') {
  key(g,value);g.frame(Math.ceil(seconds/.05),50);key(g,value,'keyup');
}
function select(g,id) {
  for(let i=0;i<100;i++) {
    if(g.state('currentKeyboardTarget()?.item.id')===id)return;
    key(g,'ArrowRight');
  }
  throw new Error('Could not select care point '+id);
}

test('all five client goals can be earned through actual care inputs and result navigation', {timeout:60000},async t=>{
  const g=await createGame({seed:1701});t.after(g.close);g.frame();
  // This integration gate exercises inputs, physics, UI navigation and
  // accounting. Pixel rendering is covered by the dedicated canvas tests.
  g.evaluate('renderScene=()=>{};');
  const expectedClients=['coder','student','anchor','foodie_vip','strawberry_nose'];
  for(let round=0;round<5;round++) {
    assert.equal(g.state('currentClient().id'),expectedClients[round]);
    g.d.getElementById('skin-canvas').focus();
    const targets=g.state('state.pimples.map(p=>({id:p.id,type:p.type}))');
    for(const p of targets) {
      select(g,p.id);key(g,'1');hold(g,3);
      if(p.type==='blackhead') {key(g,'4');hold(g,3.6);}
      else {
        if(p.type==='cyst') {key(g,'2');hold(g,.1,'Enter');}
        key(g,'3');hold(g,p.type==='cyst'?8:4);
        key(g,'5');hold(g,3);
      }
      assert.ok(g.state(`state.pimples.find(p=>p.id===${JSON.stringify(p.id)}).state>=P_STATE.HEALING`),`${expectedClients[round]} ${p.type} can be cleaned`);
    }
    assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'),targets.length);
    g.click('btn-ice-quick');g.frame(65);
    const record=g.state('careRecords.history[0]');
    assert.equal(record.clientId,expectedClients[round]);
    assert.equal(record.grade,'S');
    assert.equal(record.goal.met,true,`${record.clientId} goal is achievable through normal tools`);
    assert.equal(record.goalFirst,true);
    assert.equal(record.income.goalBonus,60);
    assert.equal(g.state('getCareJourney().count'),round+1);
    g.click('btn-next-face');await new Promise(setImmediate);g.frame();
  }
  assert.equal(g.state('getCareJourney().complete'),true);
  assert.equal(g.state('state.coins'),2210);
  assert.equal(g.state('careRecords.history.length'),5);
  assert.equal(g.d.getElementById('clinic-modal').classList.contains('open'),true);
  assert.match(g.d.getElementById('journey-status').textContent,/本章|集齐/);
  assert.deepEqual(g.runtimeErrors,[]);
});
