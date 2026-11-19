const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createGame } = require('./harness.cjs');

// Real game functions, DOM events and Skia Canvas. Rule fixtures are explicit:
// completion fixtures isolate accounting; force fixtures feed the normal simulation.
// Browser layout, touch hardware and audible audio are outside this suite.
async function gameFor(t, options = {}) {
  const game = await createGame({legacyRecipe:true, input: path.join(__dirname, '..', 'index.html'), seed: 61234, ...options });
  t.after(() => { assert.deepEqual(game.runtimeErrors, []); game.close(); });
  game.frame(2);
  return game;
}

function newRun(game, client = 0, density = 0) {
  game.evaluate(`document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
    state.clientIndex=${client}; state.targetDensity=${density}; generateLevel(${density});
    if (state.practiceGuide) state.practiceGuide.active=false;
    state.paused=false; selectTool('steam');`);
  game.frame();
}

function point(game, type) {
  return game.evaluate(`(()=>{const p=state.pimples.find(p=>p.type===${JSON.stringify(type)});return {id:p.id,x:p.x,y:p.y};})()`);
}

function tap(game, tool, p) {
  game.click(`tool-${tool}`);
  game.mouse('skin-canvas', 'mousedown', p.x, p.y);
  game.mouse(game.w, 'mouseup', p.x, p.y);
  game.frame();
}

function finishFixture(game, score = 1000) {
  game.evaluate(`state.score=${score};state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();`);
  game.click('btn-ice-quick');
  game.frame(65);
  assert.equal(game.state('state.settled'), true);
}

function records(game) { return JSON.parse(game.w.localStorage.getItem('pimple_clinic_profile_v3')).records; }

test('whitehead has one owner, one tray entry and one reward at each extraction/collection step', async t => {
  const g = await gameFor(t); newRun(g);
  const p = point(g, 'whitehead');
  g.click('tool-squeeze');g.mouse('skin-canvas','mousedown',p.x,p.y);g.mouse(g.w,'mousemove',p.x,p.y);
  let frames=0;
  while(g.state(`state.pimples.find(p=>p.id===${p.id}).state`)!==3 && frames++<240)g.frame();
  g.mouse(g.w,'mouseup',p.x,p.y);g.frame(32);assert.ok(frames<240);
  const residue=g.state(`({...state.surfaceResidues.find(r=>r.kind==='core_seed'&&r.pimpleId===${p.id})})`);
  assert.ok(residue.collectionId);assert.equal(g.state('state.coreSeedsCollected'),0);
  assert.equal(g.state(`state.collectionLedger['${residue.collectionId}'].location`),'skin');
  const score=g.state('state.score');tap(g,'tweezers',residue);g.frame(32);
  assert.equal(g.state('state.coreSeedsCollected'),1);assert.equal(g.state('state.score'),score+45);
  const duplicate=g.evaluate(`({emit:emitSolidSebaceousCorePlug(state.pimples.find(p=>p.id===${p.id})),launch:launchTrophyToDish(0,0,'seed',18,'${residue.collectionId}'),finish:finalizeTrophyInTray('seed',18,'${residue.collectionId}'),reward:rewardTrophyOnce('${residue.collectionId}','collect',45,0,0,'重复')})`);
  assert.deepEqual(JSON.parse(JSON.stringify(duplicate)),{emit:false,launch:false,finish:false,reward:false});
  assert.equal(g.state('state.coreSeedsCollected'),1);assert.equal(g.state('state.score'),score+45);
  for(let i=0;i<8;i++)tap(g,'swab',p);g.frame(65);
  assert.equal(g.state(`state.pimples.find(p=>p.id===${p.id}).state`),5);
  assert.equal(g.state('state.coreSeedsCollected'),1);
});

test('swab transfers whitehead and cyst cores instead of losing or duplicating them', async t => {
  const g=await gameFor(t);
  for(const type of ['whitehead','cyst']) {
    newRun(g);const p=point(g,type);
    // Only the nearly-empty stage is a fixture; drain, emission, wiping and healing are real.
    g.evaluate(`(()=>{const p=state.pimples.find(p=>p.id===${p.id});p.state=P_STATE.EXTRUDING;p.pusRemaining=.001;applySqueezeToExtruding(p,.65,p.targetAngle,.05);})()`);
    assert.equal(g.state('state.coreSeedsCollected'),0);
    for(let i=0;i<8;i++)tap(g,'swab',p);g.frame(65);
    assert.equal(g.state('state.coreSeedsCollected'),1);
    assert.equal(g.state(`state.pimples.find(p=>p.id===${p.id}).state`),5);
    assert.equal(g.state(`state.surfaceResidues.filter(r=>r.pimpleId===${p.id}).length`),0);
  }
});

test('steamer reduces softened pulling distance to 24 px; unsoftened targets retain 32 px', async t => {
  const g=await gameFor(t);
  for(const upgraded of [false,true]) {
    newRun(g,4);g.evaluate(`state.upgrades.steamer=${upgraded}`);const p=point(g,'blackhead');
    g.mouse('skin-canvas','mousedown',p.x,p.y);g.frame(140);g.mouse(g.w,'mouseup',p.x,p.y);
    assert.equal(g.state(`state.pimples.find(p=>p.id===${p.id}).steamed`),1);
    g.click('tool-tweezers');g.mouse('skin-canvas','mousedown',p.x,p.y);
    for(let n=1;n<=4;n++){g.mouse(g.w,'mousemove',p.x+n*4,p.y);g.frame();}
    assert.ok(Math.abs(g.state('state.tweezers.pullRatio')-(upgraded?2/3:.5))<1e-8);
    for(let n=5;n<=(upgraded?6:8);n++){g.mouse(g.w,'mousemove',p.x+n*4,p.y);g.frame();}
    g.mouse(g.w,'mouseup',p.x+(upgraded?24:32),p.y);g.frame(65);
    assert.equal(g.state('state.trophiesPlucked'),1);
  }
  newRun(g,4);g.evaluate('state.upgrades.steamer=true');const p=point(g,'blackhead');tap(g,'needle',p);
  g.click('tool-tweezers');g.mouse('skin-canvas','mousedown',p.x,p.y);
  for(let n=1;n<=4;n++){g.mouse(g.w,'mousemove',p.x+n*4,p.y);g.frame();}
  assert.ok(Math.abs(g.state('state.tweezers.pullRatio')-.5)<1e-8);
});

test('cotton upgrade heals six points once per completed site, matching its description', async t => {
  const g=await gameFor(t);newRun(g);const p=point(g,'whitehead');
  g.evaluate(`state.upgrades.iceprobe=true;state.damage=20;state.pimples.find(p=>p.id===${p.id}).state=P_STATE.OOZING;`);
  for(let i=0;i<4;i++)tap(g,'swab',p);
  assert.equal(g.state('state.damage'),14);
  for(let i=0;i<6;i++)tap(g,'swab',p);
  assert.equal(g.state('state.damage'),14);
  assert.match(g.state("UPGRADES.find(u=>u.key==='iceprobe').desc"),/6 个百分点/);
});

test('recommendations favor this goal without removing legal grabbing routes or badges', async t => {
  const g=await gameFor(t);
  for(const variant of ['warm_black','pierced_black','exposed_black','white','cyst']) {
    newRun(g);const type=variant==='white'?'whitehead':variant==='cyst'?'cyst':'blackhead';const p=point(g,type);
    g.evaluate(`(()=>{const p=state.pimples.find(p=>p.id===${p.id});
      ${variant==='warm_black'?'p.steamed=1;':variant==='pierced_black'?'p.pierced=true;':variant==='exposed_black'?'p.state=P_STATE.EXTRUDING;p.extrudeProgress=.16;':'p.state=P_STATE.EXTRUDING;'}
      updateHUD();})()`);
    const advice = ['pierced_black','exposed_black'].includes(variant) ? 'steam' : 'tweezers';
    assert.equal(g.state(`getRecommendedTool(state.pimples.find(p=>p.id===${p.id}))`),advice);
    assert.ok(Number(g.d.getElementById('badge-tweezers').textContent)>=1);
    g.click('tool-tweezers');g.mouse('skin-canvas','mousedown',p.x,p.y);
    assert.equal(g.state('state.tweezers.clampedPimple.id'),p.id);
    g.mouse(g.w,'mouseup',p.x,p.y);
  }
  newRun(g);const c=point(g,'cyst');
  assert.equal(g.state(`getRecommendedTool(state.pimples.find(p=>p.id===${c.id}))`),'needle');
  tap(g,'needle',c);assert.equal(g.state(`getRecommendedTool(state.pimples.find(p=>p.id===${c.id}))`),'squeeze');
});

test('continuous misuse counts once per action, damage keeps accumulating, and healing preserves history', async t => {
  const g=await gameFor(t);newRun(g);
  // Rule-level action boundaries; the input suite verifies mouse/touch/keyboard hooks.
  g.evaluate("beginCareAction();for(let i=0;i<20;i++)addDamage(.5,10,10,'持续误操作');");
  assert.equal(g.state('state.runStats.mistakes'),1);assert.equal(g.state('state.runStats.totalDamage'),10);
  g.evaluate("beginCareAction();addDamage(5,10,10,'新一次误操作');");
  assert.equal(g.state('state.runStats.mistakes'),2);assert.equal(g.state('state.runStats.totalDamage'),15);
  const p=point(g,'whitehead');g.evaluate(`state.upgrades.iceprobe=true;state.pimples.find(p=>p.id===${p.id}).state=P_STATE.OOZING;`);
  for(let i=0;i<4;i++)tap(g,'swab',p);
  assert.equal(g.state('state.damage'),9);assert.equal(g.state('state.runStats.totalDamage'),15);
  finishFixture(g);
  assert.equal(g.state('state.damage'),3);assert.equal(records(g).history[0].grade,'A');
  assert.equal(records(g).history[0].stats.totalDamage,15);assert.equal(records(g).history[0].stats.mistakes,2);
});

test('pressure above 90 percent is recorded; gentle force still finishes each lesion type', async t => {
  const g=await gameFor(t);
  for(const type of ['blackhead','whitehead','cyst']) {
    newRun(g);const p=point(g,type);
    if(type==='cyst')tap(g,'needle',p);
    // Input-force fixture: all states advance through the ordinary simulation.
    g.evaluate(`(()=>{const p=state.pimples.find(p=>p.id===${p.id});selectTool('squeeze');beginCareAction();
      Object.assign(state.pointer,{active:true,mode:'mirror-pinch',lockedPimple:p,anchorX:p.x,anchorY:p.y,initSpan:90,axisAngle:p.targetAngle,rawForce:.55,squeezeForce:.55});
      for(let i=0;i<600&&p.state!==P_STATE.OOZING;i++)updateSimulation(.02);
      releasePointer();renderScene();})()`);
    assert.equal(g.state(`state.pimples.find(p=>p.id===${p.id}).state`),3,type);
    assert.equal(g.state('state.runStats.totalDamage'),0,type);assert.equal(g.state('state.runStats.mistakes'),0,type);
  }
  newRun(g);const p=point(g,'whitehead');
  g.evaluate(`(()=>{const p=state.pimples.find(p=>p.id===${p.id});selectTool('squeeze');beginCareAction();Object.assign(state.pointer,{active:true,mode:'mirror-pinch',lockedPimple:p,anchorX:p.x,anchorY:p.y,initSpan:90,axisAngle:0,rawForce:1.1,squeezeForce:1.1});updateSimulation(.02);renderScene();})()`);
  assert.ok(g.state('state.runStats.totalDamage')>0);assert.equal(g.state('state.runStats.mistakes'),1);
  assert.match(g.d.getElementById('hint-banner').textContent,/松一点/);assert.match(g.d.getElementById('canvas-status').textContent,/松一点/);
  g.evaluate('state.pointer.rawForce=.9;state.pointer.squeezeForce=.9;');const damage=g.state('state.runStats.totalDamage');
  g.evaluate('updateSimulation(.02);');assert.equal(g.state('state.runStats.totalDamage'),damage);
});

test('a snapped cap breaks the streak and records one mistake without ending the run', async t => {
  const g=await gameFor(t);newRun(g,4);const p=point(g,'blackhead');tap(g,'needle',p);
  g.click('tool-tweezers');g.mouse('skin-canvas','mousedown',p.x,p.y);g.mouse(g.w,'mousemove',p.x+20,p.y);g.frame();
  assert.equal(g.state('state.runStats.snaps'),1);assert.equal(g.state('state.runStats.mistakes'),1);
  assert.equal(g.state('state.combo'),0);assert.equal(g.state('state.settled'),false);assert.equal(g.state('state.paused'),false);
});

test('unfinished points and abandoned runs never become completed best scores', async t => {
  const g=await gameFor(t,{storage:{pimple_pop_best_score:'9999'}});newRun(g,4);
  const points=g.state('state.pimples.map(p=>({id:p.id,x:p.x,y:p.y}))');for(const p of points)tap(g,'needle',p);
  assert.ok(g.state('state.score')>0);assert.equal(g.state('state.bestScore'),0);
  assert.equal(g.w.localStorage.getItem('pimple_clinic_records_v2'),null);
  g.evaluate('for(let i=0;i<1200;i++)updateSimulation(.05);');assert.equal(g.state('state.combo'),12);
  assert.match(g.d.getElementById('combo-tag').textContent,/连贯 12 步/);
  g.click('btn-reset');g.click('btn-confirm-reset');g.frame();assert.equal(g.state('state.bestScore'),0);
  assert.equal(g.w.localStorage.getItem('pimple_pop_best_score'),'9999','legacy peak is retained without presenting it as a completed record');
});

test('completed bests are isolated by customer, density and assisted input, with frozen run settings', async t => {
  const g=await gameFor(t);newRun(g,0);finishFixture(g,1200);
  assert.equal(g.state('state.bestScore'),1200);const first=records(g).history[0];
  g.evaluate('state.targetDensity=11;openSettlementModal();');assert.equal(records(g).history.length,1);assert.equal(first.density,0);
  newRun(g,0,8);assert.equal(g.state('state.bestScore'),0);finishFixture(g,800);
  newRun(g,1);assert.equal(g.state('state.bestScore'),0);finishFixture(g,500);
  newRun(g,0);assert.equal(g.state('state.bestScore'),1200);
  g.evaluate("state.controlMode='keyboard';beginCareAction();state.controlMode='pointer';beginCareAction();");
  assert.equal(g.state('state.runControlMode'),'keyboard');assert.equal(g.state('state.bestScore'),0);
  g.evaluate('state.upgrades.steamer=true;');finishFixture(g,1500);
  const saved=records(g);assert.equal(Object.keys(saved.bests).length,4);
  assert.equal(saved.history[0].inputMode,'keyboard');assert.equal(saved.history[0].upgrades.steamer,true);
  newRun(g,0);assert.equal(g.state('state.bestScore'),1200);
});

test('settlement pays once per run across repeated rendering and a fresh page load', async t => {
  const g=await gameFor(t);newRun(g,0);finishFixture(g,1234);
  const coins=g.state('state.coins'),runId=g.state('state.runId'),stored=g.storage();
  g.evaluate('openSettlementModal();openSettlementModal();');assert.equal(g.state('state.coins'),coins);assert.equal(records(g).history.length,1);
  const reload=await gameFor(t,{storage:stored});newRun(reload,0);
  reload.evaluate(`state.runId=${JSON.stringify(runId)};state.settled=true;state.resultRecorded=false;state.pimples.forEach(p=>p.state=P_STATE.HEALED);openSettlementModal();`);
  assert.equal(reload.state('state.coins'),coins);assert.equal(records(reload).history.length,1);assert.equal(reload.state('state.bestScore'),1234);
  assert.equal(records(reload).history[0].clientId,'coder');
});

test('twelve actual blackhead extractions finish normally, earn the optional goal, and remain replayable', async t => {
  const g=await gameFor(t);newRun(g,4);const points=g.state('state.pimples.map(p=>({id:p.id,x:p.x,y:p.y}))');
  for(const p of points) {
    tap(g,'needle',p);g.click('tool-tweezers');g.mouse('skin-canvas','mousedown',p.x,p.y);
    for(let n=1;n<=8;n++){g.mouse(g.w,'mousemove',p.x+n*4,p.y);g.frame();}
    g.mouse(g.w,'mouseup',p.x+32,p.y);g.frame(65);
  }
  assert.equal(g.state('state.trophiesPlucked'),12);assert.equal(g.state('state.pimples.filter(p=>p.state===P_STATE.HEALED).length'),12);
  g.click('btn-ice-quick');g.frame(65);const result=records(g).history[0];
  assert.equal(result.grade,'S');assert.equal(result.goal.met,true);assert.equal(result.stats.cleanExtractions,12);
  assert.equal(result.goal.met,true);
  newRun(g,4);
  assert.equal(g.state('state.settled'),false);assert.equal(g.state('state.pimples.length'),12);assert.equal(g.state('state.score'),0);
});

test('relaxed play has no timer or hard failure and mistakes never block the next level', async t => {
  const g=await gameFor(t);newRun(g,3);
  for(let i=0;i<22;i++)g.evaluate('beginCareAction();handleNeedleTap({x:4,y:4});');
  assert.equal(g.state('state.damage'),100);assert.equal(g.state('state.runStats.mistakes'),22);
  g.evaluate('for(let i=0;i<1200;i++)updateSimulation(.05);');assert.equal(g.state('state.paused'),false);assert.equal(g.state('state.settled'),false);
  finishFixture(g);assert.equal(g.state('wardrobeProgress.level'),2);
  assert.equal(records(g).history[0].earnedCoins,460);assert.ok(records(g).history[0].stats.totalDamage>100);
});

test('legacy session stats retain known damage, and malformed completed records cannot crash startup', async t => {
  const g=await gameFor(t,{storage:{pimple_clinic_records_v2:'{"version":2,"bests":{"bad":null},"history":[null,{},42]}'}});newRun(g);
  g.evaluate('state.damage=23;state.runStats=null;normalizeRunStats();updateHUD();');
  assert.equal(g.state('state.runStats.totalDamage'),23);assert.equal(g.state('state.runStats.peakDamage'),23);
  assert.equal(g.state('state.runStats.mistakes'),1);
  g.click('btn-clinic');assert.equal(g.d.getElementById('care-record-count').textContent,'0');
  g.evaluate("state.runStats=[];state.actionSerial='bad';normalizeRunStats();beginCareAction();addDamage(1,5,5);addDamage(1,5,5);");
  assert.equal(g.state('Array.isArray(state.runStats)'),false);assert.equal(g.state('state.runStats.mistakes'),2);
});

