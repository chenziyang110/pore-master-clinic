const test=require('node:test');
const assert=require('node:assert/strict');
const {createGame}=require('./harness.cjs');
const {setupRound}=require('./round-fixture.cjs');

const PROFILE='pimple_clinic_profile_v3';
const plain=value=>JSON.parse(JSON.stringify(value));
const REGIONS=['nose_cheek','nose_tip','chin_jaw','forehead','mouth_ring'];
const total=recipe=>Object.values(recipe).reduce((sum,count)=>sum+count,0);

async function game(t,options={}) {
  const g=await createGame({seed:831720,...options});
  t.after(()=>{assert.deepEqual(g.runtimeErrors,[]);g.close();});
  g.frame();g.evaluate('renderScene=()=>{};');
  return g;
}

function spyRestoredDraws(w) {
  w.addEventListener('load',()=>w.eval(`
    window.planDraws=0;window.rewardDraws=0;
    const originalPlan=chooseAdventurePlan,originalRewards=rollAdventureGifts;
    chooseAdventurePlan=(...args)=>{window.planDraws++;return originalPlan(...args);};
    rollAdventureGifts=(...args)=>{window.rewardDraws++;return originalRewards(...args);};
  `),{once:true});
}

function snapshot(g) {
  return plain(g.state(`({runId:state.runId,level:state.runLevel,plan:state.roundPlan,
    region:currentTreatmentRegion().id,rhythm:wardrobeProgress.careRhythm,discovered:state.discoveredGifts,
    pimples:state.pimples.map(p=>({id:p.id,type:p.type,state:p.state,x:p.x,y:p.y,nx:p.nx,ny:p.ny,radius:p.radius,
      steamed:p.steamed,shape:p.shape,wormTotalLen:p.wormTotalLen,wormSeed:p.wormSeed,wormCurlDir:p.wormCurlDir,
      linkedPore:p.linkedPore,sharedPore:p.sharedPore,blackheadCount:p.blackheadCount,blackheadLengths:p.blackheadLengths,
      blackheadSize:p.blackheadSize,whiteheadSize:p.whiteheadSize,giftId:p.giftId}))})`));
}

function assertGeneratedBoard(g) {
  const board=plain(g.state(`({plan:state.roundPlan,region:currentTreatmentRegion().id,
    recipe:Object.fromEntries(['blackhead','whitehead','cyst'].map(type=>[type,state.pimples.filter(p=>p.type===type).length])),
    count:state.pimples.length,valid:state.pimples.every(p=>validPoreVariant(p)&&validBlackheadCount(p)&&validSharedPore(p)),
    gifts:state.pimples.filter(p=>p.giftId).map(p=>({id:p.id,gift:p.giftId})),
    shared:state.pimples.some(p=>p.sharedPore)})`));
  assert.ok(board.plan&&REGIONS.includes(board.plan.region));
  assert.equal(board.region,board.plan.region);
  assert.deepEqual(board.recipe,board.plan.recipe,'the actual generated contents match the saved random plan');
  assert.equal(board.count,total(board.plan.recipe));
  assert.equal(board.valid,true,'every generated pore satisfies all real variant validators');
  assert.ok(board.gifts.length<=3&&board.gifts.length<=board.count);
  assert.equal(new Set(board.gifts.map(item=>item.id)).size,board.gifts.length,'each reward belongs to a separate real pore');
  assert.equal(new Set(board.gifts.map(item=>item.gift)).size,board.gifts.length);
  if(!board.recipe.whitehead&&!board.recipe.cyst)assert.equal(board.shared,false,'a pure blackhead round never conceals a shared whitehead');
  return board;
}

function finishBoard(g) {
  // This test accelerates extraction only. It keeps the generated plan and
  // bindings, normal ice button, real completion record and atomic profile save.
  // chapter-flow.test.cjs separately performs the complete real care inputs.
  g.evaluate(`state.pimples.forEach(p=>{
    if(p.sharedPore){p.sharedPore.phase='done';if(p.sharedPore.mode==='sequential'){p.type='whitehead';p.cfg=CONFIG.TYPES.WHITEHEAD;}}
    p.state=P_STATE.HEALED;p.healProgress=1;
  });updateHUD();`);
  g.click('btn-ice-quick');g.frame(65);
  assert.equal(g.state('state.settled'),true);
  assert.equal(g.state('careRecords.history[0].runId'),g.state('state.runId'));
}

test('starting new unfinished rounds and opening UI never consume completed busy rounds',async t=>{
  const g=await game(t);
  g.evaluate(`wardrobeProgress.level=8;wardrobeProgress.careRhythm={busyCompleted:1,busyTarget:3,lastRegion:'nose_tip',lastCount:9};`);
  const rhythm=plain(g.state('wardrobeProgress.careRhythm'));
  for(let index=0;index<3;index++) {
    g.evaluate('generateLevel(0);state.paused=false;updateHUD();renderWardrobe();');
    const board=assertGeneratedBoard(g);
    assert.equal(board.plan.pace,'busy');assert.notEqual(board.plan.region,rhythm.lastRegion);
    g.click('btn-wardrobe');g.click('btn-close-wardrobe');g.frame(3);
    assert.deepEqual(plain(g.state('wardrobeProgress.careRhythm')),rhythm);
  }
});

test('real random rounds alternate two or three completed busy boards with one light board and survive repeated reloads',
  {timeout:60000},async t=>{
  let g=await game(t),busyStreak=0,lightRounds=0,pureBlackRounds=0,previousRegion=null;
  for(let level=1;level<=24;level++) {
    assert.equal(g.state('state.runLevel'),level);
    const board=assertGeneratedBoard(g),count=board.count;
    const before=plain(g.state('wardrobeProgress.careRhythm'));
    if(previousRegion)assert.notEqual(board.plan.region,previousRegion,'the next completed round uses a different region');
    if(level<=2) {
      assert.equal(board.plan.pace,'intro');
      assert.deepEqual(board.recipe,{blackhead:level===1?3:4,whitehead:0,cyst:0});
    } else if(board.plan.pace==='busy') {
      assert.ok(before.busyCompleted<before.busyTarget);
      assert.ok(count>=(level===3?6:8)&&count<=(level===3?8:12));
      busyStreak++;
    } else {
      assert.equal(board.plan.pace,'light');
      assert.ok(busyStreak===2||busyStreak===3,'a light round follows exactly two or three completed busy rounds');
      assert.equal(before.busyCompleted,before.busyTarget);
      assert.ok(count>=3&&count<=4);busyStreak=0;lightRounds++;
    }
    if(level>2&&!board.recipe.whitehead&&!board.recipe.cyst)pureBlackRounds++;

    if([4,10,19].includes(level)) {
      const p=g.state('state.pimples[0]');
      g.click('tool-steam');g.mouse('skin-canvas','mousedown',p.x,p.y);g.frame(6,50);g.mouse(g.w,'mouseup',p.x,p.y);
      assert.ok(p.steamed>0&&p.steamed<1,'the saved board includes real partial care');
      g.evaluate('saveCurrentSession(true);');
      const expected=snapshot(g),stored=g.storage();g.close();
      g=await game(t,{storage:stored,seed:917+level,setupWindow:spyRestoredDraws});
      assert.equal(g.w.planDraws,0,'restoring the round never redraws its body region or recipe');
      assert.equal(g.w.rewardDraws,0,'restoring the round never rerolls its bound gifts');
      assert.deepEqual(snapshot(g),expected,'region, counts, geometry, variants, gifts and partial care survive a reload');
      assertGeneratedBoard(g);
    }

    finishBoard(g);
    const after=plain(g.state('wardrobeProgress.careRhythm'));
    assert.equal(after.lastRegion,board.plan.region);assert.equal(after.lastCount,count);
    assert.equal(after.busyCompleted,board.plan.pace==='busy'?before.busyCompleted+1:board.plan.pace==='light'?0:before.busyCompleted);
    assert.ok(after.busyTarget===2||after.busyTarget===3);
    if(board.plan.pace!=='light')assert.equal(after.busyTarget,before.busyTarget);
    const profile=JSON.parse(g.w.localStorage.getItem(PROFILE));
    assert.deepEqual(profile.wardrobe.careRhythm,after,'the actual completion writes its new rhythm');
    g.evaluate('openSettlementModal();openSettlementModal();');
    assert.deepEqual(plain(g.state('wardrobeProgress.careRhythm')),after,'reopening a result cannot count the same busy round twice');
    previousRegion=board.plan.region;
    if(level<24) {g.click('btn-next-face');await new Promise(setImmediate);g.frame();}
  }
  assert.ok(lightRounds>=5,'completed play repeatedly reaches the less crowded rounds');
  assert.ok(pureBlackRounds>0,'real generated play includes a later all-blackhead round');
  assert.equal(g.state('careRecords.history.length'),24);
});

test('malformed or mismatched saved plans are rejected without replacing the current board',async t=>{
  const g=await game(t);g.evaluate('saveCurrentSession(true);');
  const source=JSON.parse(g.w.localStorage.getItem(PROFILE)).session;
  const run=g.state('state.runId');
  const badPlans=[
    {...source.data.roundPlan,version:2},
    {...source.data.roundPlan,region:'unknown_region'},
    {...source.data.roundPlan,pace:'endless'},
    {...source.data.roundPlan,recipe:{blackhead:-1,whitehead:4,cyst:0}},
    {...source.data.roundPlan,recipe:{blackhead:2,whitehead:1,cyst:0}}
  ];
  for(const plan of badPlans) {
    const saved=plain(source);saved.data.roundPlan=plan;
    assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(saved))})`),false);
    assert.equal(g.state('state.runId'),run);
  }
});

test('a saved pre-plan board keeps its old care region and migrates the rhythm without rerolling',async t=>{
  const source=await game(t);
  setupRound(source,{level:4,region:'chin_jaw',recipe:{blackhead:4,whitehead:2,cyst:0}});
  const expected=snapshot(source),profile=JSON.parse(source.w.localStorage.getItem(PROFILE));
  delete profile.session.data.roundPlan;delete profile.wardrobe.careRhythm;
  const restored=await game(t,{storage:{[PROFILE]:JSON.stringify(profile)},setupWindow:spyRestoredDraws,seed:7});
  assert.equal(restored.w.planDraws,0);assert.equal(restored.w.rewardDraws,0);
  assert.equal(restored.state('state.roundPlan'),null);
  assert.equal(restored.state('currentTreatmentRegion().id'),'chin_jaw');
  assert.equal(restored.state('state.runId'),expected.runId);
  assert.deepEqual(snapshot(restored).pimples,expected.pimples);
  assert.deepEqual(plain(restored.state('wardrobeProgress.careRhythm')),
    {busyCompleted:0,busyTarget:2,lastRegion:null,lastCount:0});
});
