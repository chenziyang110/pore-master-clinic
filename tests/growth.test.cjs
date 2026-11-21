const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const tick = () => new Promise(setImmediate);
const read = g => JSON.parse(g.storage()[PROFILE]);
const plain = value => JSON.parse(JSON.stringify(value));

async function game(t, options = {}) {
  const g = await createGame({legacyRecipe:true,seed:9101, ...options});
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  return g;
}

function start(g, client = 0, density = 0, input = 'pointer') {
  g.evaluate(`document.querySelectorAll('.modal-backdrop.open').forEach(m=>m.classList.remove('open'));
    state.clientIndex=${client};generateLevel(${density});state.runControlMode=${JSON.stringify(input)};state.controlMode=${JSON.stringify(input)};
    if(state.practiceGuide)state.practiceGuide.active=false;state.paused=false;`);
  g.frame();
}

function chooseClient(g, client) {
  if (!g.d.getElementById('clinic-modal').classList.contains('open')) g.click('btn-clinic');
  g.d.querySelectorAll('#client-list-container .client-card')[client].click();
  g.frame();
}

function beginWithKeyboard(g) {
  const canvas = g.d.getElementById('skin-canvas');
  canvas.focus();
  canvas.dispatchEvent(new g.w.KeyboardEvent('keydown', {key:' ',bubbles:true,cancelable:true}));
  g.frame(2);
  g.w.dispatchEvent(new g.w.KeyboardEvent('keyup', {key:' ',bubbles:true,cancelable:true}));
  assert.equal(g.state('state.runControlMode'), 'keyboard');
}

function finish(g, {goal = true, score = 1000, damage = 0, mistakes = 0, snaps = 0} = {}) {
  // Finished extractions are a fixture; the real ice action, goal evaluation,
  // settlement, canonical profile write and result UI perform the accounting.
  g.evaluate(`state.score=${score};state.damage=0;
    state.runStats.totalDamage=${damage};state.runStats.mistakes=${mistakes};state.runStats.snaps=${snaps};
    state.runStats.cleanExtractions=state.pimples.reduce((sum,p)=>sum+(p.poreSequence?.count||(p.sharedPore?.mode==='sequential'?2:1)),0);
    state.collectionLedger={};state.trophyTrayItems=[];state.flyingTrophies=[];state.surfaceResidues=[];
    state.trophiesPlucked=0;state.coreSeedsCollected=0;
    for(const p of state.pimples){
      p.state=P_STATE.HEALED;p.healProgress=1;
      if(${goal}){
        const contents=p.sharedPore?.mode==='sequential'?['blackhead','whitehead']
          :Array(p.poreSequence?.count||1).fill(p.type);
        contents.forEach((sourceType,index)=>{
          const kind=sourceType==='blackhead'?'blackhead':'seed';
          const id=kind+':'+p.id+(p.poreSequence&&index?':core:'+(index+1):'');
          state.collectionLedger[id]={location:'tray',kind,sourceType,softened:true,pierced:true,gentle:true,
            rewards:{extract:true,collect:true},
            blackheadCount:kind==='blackhead'?getBlackheadCount(p):1,
            blackheadLengths:kind==='blackhead'?getBlackheadLengths(p):[1],
            blackheadSize:kind==='blackhead'?(p.blackheadSize||'normal'):'normal',
            whiteheadSize:kind==='seed'?(p.whiteheadSize||'normal'):'normal',
            pairedWhitehead:kind==='blackhead'&&p.sharedPore?.mode==='together',
            ...(p.poreSequence?{sourcePimpleId:p.id,sequenceIndex:index}:{})};
          if(state.trophyTrayItems.length<20)state.trophyTrayItems.push({collectionId:id,kind,wormLen:28,ox:0,oy:0,rot:0});
          if(kind==='blackhead')state.trophiesPlucked++;else state.coreSeedsCollected++;
        });
        if(p.poreSequence)p.poreSequence.index=p.poreSequence.count-1;
      }
      if(p.sharedPore){
        if(p.sharedPore.mode==='sequential'){p.type='whitehead';p.cfg=CONFIG.TYPES.WHITEHEAD;}
        p.sharedPore.phase='done';
      }
    }
    updateHUD();`);
  g.click('btn-ice-quick');g.frame(65);
  assert.equal(g.state('state.settled'), true);
  assert.ok(g.d.getElementById('result-modal').classList.contains('open'));
  return read(g).records.history[0];
}

async function deliver(hub) {
  for(let i=0;i<8;i++){hub.flush();await tick();if(!hub.pendingCount)return;}
  assert.equal(hub.pendingCount,0);
}

test('legacy optional-goal accounting pays once across quantities, input modes and refresh', async t => {
  const g = await game(t);
  let record = finish(g);
  assert.equal(record.goal.met, true);
  assert.equal(record.goalFirst, true);
  assert.deepEqual(record.income, {base:200,tip:80,goalBonus:60});
  assert.equal(g.state('state.coins'), 340);
  g.evaluate('openSettlementModal();openSettlementModal();');
  assert.equal(g.state('state.coins'), 340);
  assert.equal(read(g).records.history.length, 1);

  start(g, 0, 11, 'keyboard');record = finish(g);
  assert.equal(record.goal.met, true);assert.equal(record.goalFirst, false);
  assert.equal(record.income.goalBonus, 0);assert.equal(g.state('state.coins'), 620);
  const restored = await game(t, {storage:g.storage()});
  assert.equal(restored.state('getCareJourney().count'), 1);
  start(restored,0);record = finish(restored);
  assert.equal(record.goalFirst, false);assert.equal(restored.state('state.coins'), 900);
});

test('a completed care without the goal does not consume its later first reward', async t => {
  const g = await game(t);
  let record = finish(g, {goal:false});
  assert.equal(record.goal.met, false);assert.equal(record.income.goalBonus, 0);
  assert.equal(g.state('getCareJourney().count'), 0);
  start(g);record = finish(g);
  assert.equal(record.income.goalBonus, 60);
  assert.equal(g.state('state.coins'), 620);
  assert.equal(g.state('getCareJourney().count'), 1);
});

test('old goal records become stamps without retroactive or repeat payment', async t => {
  const source = await game(t);finish(source);
  const base = read(source);
  delete base.records.history[0].income;
  delete base.records.history[0].goalFirst;
  base.coins = 280;
  for (const keep of ['bests', 'history']) {
    const legacy = plain(base);
    if(keep === 'bests')legacy.records.history=[];
    else legacy.records.bests={};
    const g = await game(t, {storage:{[PROFILE]:JSON.stringify(legacy)}});
    start(g,0);
    assert.equal(g.state('state.coins'), 280, 'migration itself grants no money');
    assert.equal(g.state('getCareJourney().count'), 1);
    assert.match(g.d.getElementById('patient-quote').textContent, /上次/);
    const record = finish(g);
    assert.equal(record.income.goalBonus, 0);
    assert.equal(g.state('state.coins'), 560);
    start(g,0);
    const revisit = finish(g, {goal:false});
    assert.equal(revisit.goal.met, false);
    assert.equal(revisit.income.goalBonus, 0);
    assert.equal(g.state('getCareJourney().count'), 1);
    assert.equal(g.state('hasCompletedCareGoal("coder")'), true);
  }
});

test('a migrated history-only stamp survives history eviction and cannot pay again', async t => {
  const source=await game(t);const original=finish(source);
  start(source,1);const later=finish(source,{goal:false,mistakes:1});
  assert.equal(later.goal.met,false);
  const legacy=read(source);
  legacy.records.bests={};
  legacy.records.history=Array.from({length:59},(_,i)=>({...plain(later),runId:'legacy-later-'+i}));
  legacy.records.history.push(plain(original));
  const g=await game(t,{storage:{[PROFILE]:JSON.stringify(legacy)}});
  assert.equal(g.state('getCareJourney().count'),1);
  start(g,1);finish(g,{goal:false,mistakes:1});
  assert.equal(read(g).records.history.length,60);
  assert.equal(read(g).records.history.some(record=>record.clientId==='coder'),false);
  assert.equal(g.state('getCareJourney().count'),1);
  const restored=await game(t,{storage:g.storage()});
  assert.equal(restored.state('getCareJourney().count'),1);
  start(restored,0);const revisit=finish(restored);
  assert.equal(revisit.goalFirst,false);
  assert.equal(revisit.income.goalBonus,0);
});

test('first-goal payment remains atomic with the record when storage fails and later recovers', async t => {
  const g = await game(t);
  const before = g.storage()[PROFILE];
  const nativeSet = g.w.Storage.prototype.setItem;
  g.w.Storage.prototype.setItem = function(key,value) {
    if(key===PROFILE)throw new g.w.DOMException('Full','QuotaExceededError');
    return nativeSet.call(this,key,value);
  };
  // finish() reads the last persisted record, so use the same real settlement
  // path but inspect the in-memory record while canonical writes are rejected.
  g.evaluate(`state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;
    if(p.type==='blackhead')state.collectionLedger['fixture-'+p.id]={location:'tray',kind:'blackhead',sourceType:p.type,softened:true,rewards:{extract:true}};});updateHUD();`);
  g.click('btn-ice-quick');g.frame(65);
  assert.equal(g.state('state.coins'),340);
  assert.equal(g.state('careRecords.history[0].goalFirst'),true);
  assert.equal(g.storage()[PROFILE],before,'failed reward does not partly overwrite the saved profile');
  g.evaluate('openSettlementModal();');assert.equal(g.state('state.coins'),340);
  g.w.Storage.prototype.setItem=nativeSet;
  assert.equal(g.evaluate('saveCurrentSession()'),true);
  assert.equal(read(g).coins,340);assert.equal(read(g).records.history.length,1);
  assert.equal(read(g).records.history[0].income.goalBonus,60);
});

test('a second page receives the earned stamp and cannot repeat its first reward', async t => {
  const hub = createStorageHub({}, {autoFlush:false});
  const a = await game(t,{storageHub:hub});
  const b = await game(t,{storageHub:hub});
  assert.equal(b.state('careControl.owned'),false);
  finish(a);
  b.click('btn-continue-here');await deliver(hub);await b.evaluate('careControlReady');b.frame();
  assert.equal(b.state('careControl.owned'),true);
  assert.equal(b.state('getCareJourney().count'),1);
  assert.equal(b.state('state.coins'),340);
  start(b,0);finish(b);
  assert.equal(b.state('state.coins'),620);
  assert.equal(read(b).records.history[0].income.goalBonus,0);
  a.evaluate('openSettlementModal();');
  assert.equal(read(b).coins,620,'inactive page cannot pay or overwrite the new reward');
});

test('legacy stamps remain intact while the new adventure continues beyond five levels', async t => {
  const g = await game(t);
  for(let client=0;client<5;client++){
    start(g,client);const record=finish(g);
    assert.equal(record.goal.met,true);assert.equal(record.income.goalBonus,60);
    assert.equal(g.state('getCareJourney().count'),client+1);
  }
  assert.equal(g.state('wardrobeProgress.level'),6);
  const restored = await game(t,{storage:g.storage()});
  assert.equal(restored.state('getCareJourney().count'),5);
  assert.equal(restored.state('wardrobeProgress.level'),6);
});

test('legacy quality bookkeeping is retained without displaying a rating or mistake counter', async t => {
  const g = await game(t);
  const record = finish(g,{damage:20,mistakes:1,snaps:1});
  assert.equal(record.stats.totalDamage,20);
  assert.equal(record.stats.mistakes,1);
  for(const id of ['care-quality-label','care-quality-history','result-rank','res-quality-reason']) {
    const node=g.d.getElementById(id);
    assert.ok(!node||node.closest('[hidden]'),id+' is excluded from the game and accessibility tree');
  }
  assert.equal(g.state('wardrobeProgress.level'),2,'mistakes do not block level completion');
});

test('old best records preserve their grade and score independently for save compatibility', async t => {
  const g = await game(t);
  finish(g,{score:1000});
  start(g);g.evaluate('state.upgrades.tweezers=true;');
  finish(g,{score:2000,mistakes:1});
  const best=plain(g.state('getCompletedBest()'));
  assert.equal(best.bestGrade,'S');
  assert.equal(best.bestScore,2000);
  assert.equal(read(g).records.history[0].upgrades.tweezers,true);
});

test('the next-stamp action resumes its current care or protects unfinished work before changing customer', async t => {
  const g = await game(t);
  const run = g.state('state.runId');
  g.click('btn-clinic');g.click('btn-journey-next');
  assert.equal(g.state('state.runId'),run);
  assert.equal(g.d.getElementById('clinic-modal').classList.contains('open'),false);
  start(g,1);
  const target = g.state('state.pimples.find(p=>p.type==="blackhead")');
  g.click('tool-needle');g.mouse('skin-canvas','mousedown',target.x,target.y);g.mouse(g.w,'mouseup',target.x,target.y);
  const currentRun=g.state('state.runId'), score=g.state('state.score');
  g.click('btn-clinic');g.click('btn-journey-next');
  assert.ok(g.d.getElementById('reset-modal').classList.contains('open'));
  assert.equal(g.state('state.clientIndex'),1);
  g.click('btn-cancel-reset');
  assert.equal(g.state('state.runId'),currentRun);assert.equal(g.state('state.score'),score);
  assert.ok(g.d.getElementById('clinic-modal').classList.contains('open'));
});

test('result navigation follows sequential levels instead of missing historical stamps', async t => {
  const g = await game(t);
  start(g,1);finish(g);
  assert.equal(g.state('getCareJourney().count'),1);
  for(let expectedLevel=2;expectedLevel<=6;expectedLevel++) {
    g.click('btn-next-face');
    assert.equal(g.state('state.runLevel'),expectedLevel);
    const run=g.state('state.runId');
    g.click('btn-next-face');
    assert.equal(g.state('state.runId'),run,'a stale second click cannot replace an active level');
    if(expectedLevel<6)finish(g,{goal:false});
  }
  assert.equal(g.state('wardrobeProgress.level'),6);
  assert.equal(g.d.getElementById('result-modal').classList.contains('open'),false);
});

test('missing old optional goals never force a replay or hide the next level', async t => {
  const g = await game(t);
  finish(g,{goal:false,mistakes:10,damage:100});
  assert.equal(g.state('careRecords.history[0].goal.met'),false);
  assert.equal(g.d.getElementById('btn-next-face').hidden,false);
  g.click('btn-next-face');
  assert.equal(g.state('state.runLevel'),2);
  finish(g,{goal:false});g.click('btn-next-face');
  assert.equal(g.state('state.runLevel'),3);
});

test('legacy completed keyboard and density groups survive history eviction without appearing as scores', async t => {
  const g = await game(t);
  finish(g,{goal:false,score:1700,mistakes:1});
  start(g,0,11,'keyboard');finish(g,{score:900});
  const checkGroups = page => {
    const bests=read(page).records.bests;
    assert.equal(bests['coder|relaxed|client|pointer'].bestScore,1700);
    assert.equal(bests['coder|relaxed|11|keyboard'].bestScore,900);
    assert.equal(bests['coder|relaxed|11|keyboard'].bestGrade,'S');
  };
  checkGroups(g);
  const saved=read(g);saved.records.history=[];
  const restored=await game(t,{storage:{[PROFILE]:JSON.stringify(saved)}});
  checkGroups(restored);
});
