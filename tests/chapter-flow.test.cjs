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

test('the first five adventure levels award only their bound random finds through real care inputs', {timeout:60000},async t=>{
  const g=await createGame({seed:1701});t.after(g.close);g.frame();
  // This integration gate exercises inputs, physics, UI navigation and
  // accounting. Pixel rendering is covered by the dedicated canvas tests.
  g.evaluate('renderScene=()=>{};');
  const giftsByRound=[[],[],['contacts_ocean','bracelet_pearl'],[],['mask_pearl']];
  const expectedOwned=new Set();
  for(let round=0;round<5;round++) {
    assert.equal(g.state('state.runLevel'),round+1);
    if(round<2)assert.equal(g.state('state.pimples.every(p=>p.type==="blackhead")'),true);
    // Keep the five-round physics gate deterministic while allowing any real
    // run to draw zero, one or two surprises. Never grant ownership directly.
    g.evaluate(`state.discoveredGifts=[];
      state.pimples.forEach((p,index)=>{p.giftId=${JSON.stringify(giftsByRound[round])}[index]||null;});
      state.initialPimples.forEach(p=>{p.giftId=state.pimples.find(item=>item.id===p.id).giftId;});`);
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
      assert.ok(g.state(`state.pimples.find(p=>p.id===${JSON.stringify(p.id)}).state>=P_STATE.HEALING`),`level ${round+1} ${p.type} can be cleaned`);
    }
    assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'),targets.length);
    g.click('btn-ice-quick');g.frame(65);
    const record=g.state('careRecords.history[0]');
    assert.equal(record.runId,g.state('state.runId'));
    assert.equal(g.state('wardrobeProgress.level'),round+2);
    const unlocked=JSON.parse(g.state('JSON.stringify(wardrobeProgress.unlocked)'));
    for(const id of giftsByRound[round])expectedOwned.add(id);
    assert.deepEqual([...unlocked].sort(),[...expectedOwned].sort());
    assert.deepEqual([...record.wardrobeGifts].sort(),[...giftsByRound[round]].sort());
    if(giftsByRound[round].length)assert.match(g.d.getElementById('result-modal').textContent,/运气超棒/);
    g.click('btn-next-face');await new Promise(setImmediate);g.frame();
  }
  assert.equal(g.state('state.runLevel'),6);
  assert.equal(g.state('careRecords.history.length'),5);
  assert.equal(g.d.getElementById('result-modal').classList.contains('open'),false);
  assert.deepEqual(g.runtimeErrors,[]);
});

