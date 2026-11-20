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
  const foods=JSON.parse(g.state('JSON.stringify(FOOD_ITEMS.slice(0,2).map(item=>item.id))'));
  const giftsByRound=[[foods[0]],[],[foods[1],'contacts_ocean'],[foods[0]],['mask_pearl']];
  const expectedOwned=new Set();
  const expectedPantry={};
  for(let round=0;round<5;round++) {
    assert.equal(g.state('state.runLevel'),round+1);
    if(round<2)assert.equal(g.state('state.pimples.every(p=>p.type==="blackhead")'),true);
    // Keep the five-round physics gate deterministic while allowing any real
    // run to find common consumable food and an occasional permanent outfit.
    // Never grant ownership or food inventory directly.
    g.evaluate(`state.discoveredGifts=[];
      state.pimples.forEach((p,index)=>{p.giftId=${JSON.stringify(giftsByRound[round])}[index]||null;});
      state.initialPimples.forEach(p=>{p.giftId=state.pimples.find(item=>item.id===p.id).giftId;});`);
    g.d.getElementById('skin-canvas').focus();
    const targets=g.state('state.pimples.map(p=>({id:p.id,type:p.type,contents:p.sharedPore?.mode==="sequential"?2:1}))');
    for(const p of targets) {
      select(g,p.id);key(g,'1');hold(g,3);
      // A random sequential opening may expose a white core after its first
      // black plug. Re-read the real target state between bounded care passes.
      for(let pass=0;pass<3;pass++) {
        const current=g.state(`state.pimples.find(item=>item.id===${JSON.stringify(p.id)})`);
        if(current.state>=g.state('P_STATE.HEALING'))break;
        select(g,p.id);
        if(current.state>=g.state('P_STATE.OOZING')) {key(g,'5');hold(g,3);}
        else if(current.type==='blackhead') {key(g,'4');hold(g,3.6);}
        else {
          if(current.type==='cyst'&&!current.pierced) {key(g,'2');hold(g,.1,'Enter');}
          key(g,'3');hold(g,current.type==='cyst'?8:4);
          key(g,'5');hold(g,3);
        }
      }
      assert.ok(g.state(`state.pimples.find(p=>p.id===${JSON.stringify(p.id)}).state>=P_STATE.HEALING`),`level ${round+1} ${p.type} can be cleaned`);
    }
    assert.equal(g.state('state.trophiesPlucked+state.coreSeedsCollected'),targets.reduce((total,p)=>total+p.contents,0));
    g.click('btn-ice-quick');g.frame(65);
    const record=g.state('careRecords.history[0]');
    assert.equal(record.runId,g.state('state.runId'));
    assert.equal(g.state('wardrobeProgress.level'),round+2);
    const unlocked=JSON.parse(g.state('JSON.stringify(wardrobeProgress.unlocked)'));
    const expectedOutfits=giftsByRound[round].filter(id=>!id.startsWith('food_'));
    const expectedFood=giftsByRound[round].filter(id=>id.startsWith('food_'));
    for(const id of expectedOutfits)expectedOwned.add(id);
    for(const id of expectedFood)expectedPantry[id]=(expectedPantry[id]||0)+1;
    assert.deepEqual([...unlocked].sort(),[...expectedOwned].sort());
    assert.deepEqual([...record.wardrobeGifts].sort(),[...expectedOutfits].sort());
    assert.deepEqual([...record.foodGifts].sort(),[...expectedFood].sort());
    assert.deepEqual(JSON.parse(g.state('JSON.stringify(wardrobeProgress.pantry)')),expectedPantry);
    assert.equal(g.state('wardrobeProgress.hunger'),Math.min(100,38+12*(round+1)));
    if(expectedOutfits.length)assert.match(g.d.getElementById('result-modal').textContent,/运气超棒/);
    for(const id of expectedFood) {
      const name=g.state(`FOOD_ITEMS.find(item=>item.id===${JSON.stringify(id)}).name`);
      assert.ok(g.d.getElementById('result-modal').textContent.includes(name),'the result names its consumable food');
    }
    g.click('btn-next-face');await new Promise(setImmediate);g.frame();
  }
  assert.equal(g.state('state.runLevel'),6);
  assert.equal(g.state('careRecords.history.length'),5);
  assert.equal(g.d.getElementById('result-modal').classList.contains('open'),false);
  assert.deepEqual(g.runtimeErrors,[]);
});

