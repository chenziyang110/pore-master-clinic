const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');

const PROFILE = 'pimple_clinic_profile_v3';
const tick = () => new Promise(setImmediate);
const read = g => JSON.parse(g.storage()[PROFILE]);
const plain = value => JSON.parse(JSON.stringify(value));

async function game(t, options = {}) {
  const g = await createGame({seed:9101, ...options});
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

function finish(g, {goal = true, score = 1000, damage = 0, mistakes = 0, snaps = 0} = {}) {
  // Finished extractions are a fixture; the real ice action, goal evaluation,
  // settlement, canonical profile write and result UI perform the accounting.
  g.evaluate(`state.score=${score};state.damage=0;
    state.runStats.totalDamage=${damage};state.runStats.mistakes=${mistakes};state.runStats.snaps=${snaps};
    state.runStats.cleanExtractions=state.pimples.length;
    state.collectionLedger={};state.trophiesPlucked=0;state.coreSeedsCollected=0;
    for(const p of state.pimples){
      p.state=P_STATE.HEALED;p.healProgress=1;
      if(${goal}){
        state.collectionLedger['fixture-'+p.id]={location:'tray',kind:p.type==='blackhead'?'blackhead':'seed',
          sourceType:p.type,softened:true,pierced:true,gentle:true,rewards:{extract:true,collect:true}};
        if(p.type==='blackhead')state.trophiesPlucked++;else state.coreSeedsCollected++;
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

test('first optional goal pays once across quantities, input modes and refresh, with an explained result', async t => {
  const g = await game(t);
  let record = finish(g);
  assert.equal(record.goal.met, true);
  assert.equal(record.goalFirst, true);
  assert.deepEqual(record.income, {base:200,tip:80,goalBonus:60});
  assert.equal(g.state('state.coins'), 340);
  assert.match(g.d.getElementById('res-income-detail').textContent, /酬金 ¥200.*小费 ¥80.*首次目标奖励 ¥60/);
  assert.match(g.d.getElementById('res-journey-title').textContent, /阿哲.*印记.*已收下/);
  g.evaluate('openSettlementModal();openSettlementModal();');
  assert.equal(g.state('state.coins'), 340);
  assert.equal(read(g).records.history.length, 1);

  start(g, 0, 11, 'keyboard');record = finish(g);
  assert.equal(record.goal.met, true);assert.equal(record.goalFirst, false);
  assert.equal(record.income.goalBonus, 0);assert.equal(g.state('state.coins'), 620);
  const restored = await game(t, {storage:g.storage()});
  assert.equal(restored.state('getCareJourney().count'), 1);
  record = finish(restored);
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
    assert.equal(g.state('state.coins'), 280, 'migration itself grants no money');
    assert.equal(g.state('getCareJourney().count'), 1);
    assert.match(g.d.getElementById('patient-quote').textContent, /上次/);
    const record = finish(g);
    assert.equal(record.income.goalBonus, 0);
    assert.equal(g.state('state.coins'), 560);
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
  finish(b);
  assert.equal(b.state('state.coins'),620);
  assert.equal(read(b).records.history[0].income.goalBonus,0);
  a.evaluate('openSettlementModal();');
  assert.equal(read(b).coins,620,'inactive page cannot pay or overwrite the new reward');
});

test('five different goals form a finite chapter with a persistent completion state', async t => {
  const g = await game(t);
  for(let client=0;client<5;client++){
    start(g,client);const record=finish(g);
    assert.equal(record.goal.met,true);assert.equal(record.income.goalBonus,60);
    assert.equal(g.state('getCareJourney().count'),client+1);
    g.click('btn-open-clinic-from-res');
    assert.equal(g.d.querySelectorAll('#journey-stamps .is-met').length,client+1);
    if(client<4)assert.match(g.d.getElementById('journey-next').textContent,/下一枚/);
  }
  assert.equal(g.d.getElementById('btn-journey-next').hidden,true);
  assert.match(g.d.getElementById('journey-status').textContent,/这一章完成/);
  assert.ok(g.d.getElementById('app-shell').classList.contains('chapter-complete'));
  assert.match(g.d.getElementById('chapter-caption').textContent,/本章完成/);
  const restored = await game(t,{storage:g.storage()});
  assert.equal(restored.state('getCareJourney().count'),5);
  assert.ok(restored.d.getElementById('app-shell').classList.contains('chapter-complete'));
  restored.click('btn-clinic');
  assert.equal(restored.d.querySelectorAll('#journey-stamps .is-met').length,5);
});

test('quality stays visible after irritation is soothed and explains why the grade fell', async t => {
  const g = await game(t);
  g.evaluate('state.runStats.totalDamage=20;state.runStats.mistakes=1;state.runStats.snaps=1;state.damage=0;updateHUD();');
  assert.equal(g.d.getElementById('damage-val').textContent,'0%');
  assert.equal(g.d.getElementById('care-quality-label').textContent,'本局表现 A');
  assert.match(g.d.getElementById('care-quality-history').textContent,/误操作 1 次.*累计刺激 20.0/);
  g.click('btn-quality-details');
  assert.ok(g.d.getElementById('plan-modal').classList.contains('open'));
  g.click('btn-close-plan');
  const record = finish(g,{damage:20,mistakes:1,snaps:1});
  assert.equal(record.grade,'A');
  assert.match(g.d.getElementById('res-quality-reason').textContent,/1 次夹断.*超过 S 级/);
  start(g);
  assert.equal(g.d.getElementById('care-quality-label').textContent,'本局表现 S');
});

test('best quality remains primary when equipment or combos raise a poorer raw score', async t => {
  const g = await game(t);
  finish(g,{score:1000});
  start(g);g.evaluate('state.upgrades.tweezers=true;');
  finish(g,{score:2000,mistakes:1});
  assert.match(g.d.getElementById('best-score-label').textContent,/最佳 S.*2000/);
  assert.match(g.d.getElementById('best-score-label').title,/包含连贯与器械奖励/);
  assert.match(g.d.querySelector('.result-score-note').textContent,/含连贯与器械奖励/);
  g.click('btn-open-clinic-from-res');
  assert.match(g.d.querySelector('#client-list-container .client-history').textContent,/最佳 S/);
  assert.match(g.d.getElementById('care-record-list').textContent,/精细钛合金夹/);
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
