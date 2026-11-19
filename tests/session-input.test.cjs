const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

test('a secondary finger cannot move or fire the primary needle', async t => {
  const g=await createGame({seed:3});t.after(g.close);g.frame();g.click('tool-needle');
  const p=g.state('state.pimples.find(p=>p.type==="cyst")');
  const first={identifier:11,clientX:p.x,clientY:p.y},second={identifier:42,clientX:4,clientY:4};
  g.touch('touchstart',[first],[first]);
  g.touch('touchstart',[first,second],[second]);
  g.touch('touchmove',[second,first],[second]);
  g.touch('touchend',[first],[second]);
  assert.equal(g.state('state.damage'),0);assert.equal(g.state('state.pointer.active'),true);
  assert.equal(g.state('state.pointer.x'),p.x);assert.equal(p.pierced,false);
  g.touch('touchend',[],[first]);
  assert.equal(p.pierced,true);assert.equal(g.state('state.pointer.active'),false);
  assert.equal(g.state('state.pointer.touchId'),null);assert.deepEqual(g.runtimeErrors,[]);
});

test('blur and touchcancel release actions without a stray needle', async t => {
  const g=await createGame({seed:4});t.after(g.close);g.frame();
  const p=g.state('state.pimples[0]');g.mouse('skin-canvas','mousedown',p.x,p.y);g.frame(3);
  g.w.dispatchEvent(new g.w.Event('blur'));const warmed=p.steamed;g.frame(6);
  assert.equal(g.state('state.pointer.active'),false);assert.ok(p.steamed<=warmed);
  g.click('tool-needle');const point={identifier:3,clientX:4,clientY:4};
  g.touch('touchstart',[point]);g.touch('touchcancel',[],[point]);
  assert.equal(g.state('state.damage'),0);assert.equal(g.state('state.pointer.active'),false);
});

test('reload restores a partial treatment, including residue, resources and an idle pointer', async t => {
  let g=await createGame({seed:5});t.after(()=>g.close());g.frame();
  g.evaluate('state.clientIndex=2;generateLevel(0);state.score=321;state.coins=456;state.upgrades.steamer=true;state.pimples[0].state=P_STATE.HEALED;state.pimples[1].steamed=.8;state.surfaceResidues.push({kind:"blob",x:120,y:150,r:4,alpha:.8,color:"#dcc7a0"});persistSaveData();releasePointer();');
  const saved=g.storage();g.close();g=await createGame({storage:saved,seed:8});g.frame();
  assert.equal(g.state('state.clientIndex'),2);assert.equal(g.state('state.score'),321);
  assert.equal(g.state('state.coins'),456);assert.equal(g.state('state.upgrades.steamer'),true);
  assert.equal(g.state('state.pimples[0].state'),5);assert.ok(g.state('state.pimples[1].steamed')>=.79);
  assert.equal(g.state('state.surfaceResidues.length'),1);assert.equal(g.state('state.pointer.active'),false);
  assert.equal(g.state('state.pimples[0].cfg===CONFIG.TYPES[state.pimples[0].type.toUpperCase()]'),true);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('corrupted or old session data falls back to a playable fresh session', async t => {
  const g=await createGame({storage:{pimple_clinic_session_v2:'{"version":2,"data":{"pimples":[null]}}',pimple_clinic_coins:'90'}});t.after(g.close);g.frame();
  assert.ok(g.state('state.pimples.length')>0);assert.equal(g.state('state.coins'),90);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('incomplete collection, residue and geometry snapshots are rejected before rendering', async t => {
  const first=await createGame({seed:19});first.frame();first.evaluate('state.score=125;saveCurrentSession();');
  const saved=first.storage();first.close();
  for (const corrupt of [data=>{delete data.collectionLedger;},data=>{data.surfaceResidues=[null];},data=>{delete data.pimples.find(p=>p.type==='cyst').headOffsetX;}]) {
    const broken=JSON.parse(saved.pimple_clinic_profile_v3);corrupt(broken.session.data);
    const g=await createGame({storage:{...saved,pimple_clinic_profile_v3:JSON.stringify(broken)}});
    try {g.frame();assert.equal(g.state('state.score'),0);assert.deepEqual(g.runtimeErrors,[]);} finally {g.close();}
  }
});

test('a collected item in flight survives repeated reloads exactly once', async t => {
  let g=await createGame({seed:20});t.after(()=>g.close());g.frame();
  const p=g.state('state.pimples.find(p=>p.type==="blackhead")');
  g.click('tool-needle');g.mouse('skin-canvas','mousedown',p.x,p.y);g.mouse(g.w,'mouseup',p.x,p.y);
  g.click('tool-tweezers');g.mouse('skin-canvas','mousedown',p.x,p.y);
  for(let dy=4;dy<=32;dy+=4)g.mouse(g.w,'mousemove',p.x,p.y-dy);
  g.mouse(g.w,'mouseup',p.x,p.y-32);const score=g.state('state.score');
  assert.equal(g.state('state.flyingTrophies.length'),1);
  for(let i=0;i<3;i++) {const saved=g.storage();g.close();g=await createGame({storage:saved});g.frame(3);g.evaluate('saveCurrentSession();');}
  g.frame(40);assert.equal(g.state('state.trophiesPlucked'),1);assert.equal(g.state('state.trophyTrayItems.length'),1);
  assert.equal(g.state('state.score'),score);assert.deepEqual(g.runtimeErrors,[]);
});
