const test=require('node:test');
const assert=require('node:assert/strict');
const {createGame}=require('./harness.cjs');
const {setupRound}=require('./round-fixture.cjs');

const PROFILE='pimple_clinic_profile_v3';
const plain=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(setImmediate);

function clockFor(window,initial=Date.UTC(2026,10,21,12)) {
  let now=initial,nextId=100000;
  const tasks=new Map(),nativeClear=window.clearTimeout.bind(window);
  window.Date.now=()=>now;
  window.setTimeout=(callback,delay=0,...args)=>{
    const id=nextId++;tasks.set(id,{at:now+Math.max(0,Number(delay)||0),callback:()=>callback.apply(window,args)});return id;
  };
  window.clearTimeout=id=>{if(!tasks.delete(id))nativeClear(id);};
  return {now:()=>now,advance(ms){
    const end=now+ms;let iterations=0;
    for(;;){
      const next=[...tasks].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;
      assert.ok(++iterations<10000,'blocked praise must not spin a polling timer');
      const[id,task]=next;now=task.at;tasks.delete(id);task.callback();
    }
    now=end;
  }};
}

function loadImages(window) {
  window.Image=class extends window.EventTarget {
    constructor(){super();this.complete=false;this.naturalWidth=0;this.naturalHeight=0;this._src='';}
    set src(value){this._src=String(value);queueMicrotask(()=>{this.complete=true;this.naturalWidth=1536;this.naturalHeight=1024;
      const event=new window.Event('load');this.onload?.(event);this.dispatchEvent(event);});}
    get src(){return this._src;}
    decode(){return Promise.resolve();}
  };
}

async function game(t,options={}) {
  let clock;
  const g=await createGame({seed:71643,width:666,height:550,...options,setupWindow(window){
    clock=clockFor(window,options.now);loadImages(window);options.setupWindow?.(window);
  }});
  g.clock=clock;g.inputTime=1000;
  let closed=false;const close=g.close;
  g.close=()=>{if(!closed){closed=true;close();}};
  t.after(()=>{assert.deepEqual(g.runtimeErrors,[]);g.close();});
  g.evaluate('renderScene=()=>{};');g.frame();await tick();return g;
}

function prepare(g,{count=8,white=1,reset=true,bundle=false,sequences=[],cluster=false,gift=false}={}) {
  if(reset)g.evaluate('wardrobeProgress.carePraise=normalizeCarePraise(null);');
  setupRound(g,{level:7,recipe:{blackhead:count,whitehead:white,cyst:0},setup:`
    finishPracticeGuide(true);wardrobeProgress.hunger=0;wardrobeProgress.pantry={};
    state.upgrades.steamer=false;state.upgrades.tweezers=false;
    state.pimples.forEach((p,index)=>{
      p.x=80+(index%5)*110;p.y=110+Math.floor(index/5)*130;p.nx=p.x/state.width;p.ny=p.y/state.height;
      p.radius=15;p.headOffsetX=0;p.headOffsetY=0;p.wormTotalLen=42;p.wormSeed=.4;
      p.steamed=1;p.state=P_STATE.EXTRUDING;p.extrudeProgress=.22;p.targetAngle=0;
    });
    if(${bundle}){state.pimples[0].blackheadCount=4;state.pimples[0].blackheadLengths=[.7,1,1.4,.8];}
    ${JSON.stringify(sequences)}.forEach((count,index)=>{if(count>1)state.pimples[index].poreSequence={count,index:0};});
    if(${cluster}){
      [[180,220],[228,220],[180,268]].forEach(([x,y],i)=>{const p=state.pimples[i];p.x=x;p.y=y;p.nx=x/state.width;p.ny=y/state.height;p.extrudeProgress=.9;});
      state.pimples.slice(3).forEach((p,i)=>{p.x=500;p.y=100+i*85;p.nx=p.x/state.width;p.ny=p.y/state.height;});
    }
    if(${gift})state.pimples[2].giftId='food_pudding';
  `});
  return g.state('state.pimples');
}

const notice=g=>g.d.getElementById('care-praise');
const visible=g=>!notice(g).hidden;
const praise=g=>plain(g.state('wardrobeProgress.carePraise'));
const saved=g=>JSON.parse(g.storage()[PROFILE]);
const nextBlack=g=>g.state("state.pimples.find(p=>p.type==='blackhead'&&p.state===P_STATE.EXTRUDING)");

function key(g,value,type='keydown') {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent(type,{key:value,bubbles:true,cancelable:true}));
}

function select(g,p) {
  g.d.getElementById('skin-canvas').focus();
  for(let i=0;i<100;i++){
    if(g.state('currentKeyboardTarget()?.item.id')===p.id)return;
    key(g,'ArrowRight');
  }
  throw new Error('Cannot select praise target '+p.id);
}

function pluck(g,p=nextBlack(g),{input='mouse',hold=false,settle=true}={}) {
  assert.ok(p,'a real unextracted target remains');
  g.click('tool-tweezers');
  const start={x:p.x,y:p.y},direction=p.x<g.state('state.width')/2?1:-1;
  g.inputTime+=60;
  if(input==='keyboard'){
    select(g,p);key(g,' ');
    assert.equal(g.state('state.tweezers.clampedPimple?.id'),p.id);
    let frames=0;while(g.state('state.tweezers.clampedPimple')&&frames++<100)g.frame(1,50);
    assert.ok(frames<100,'the real keyboard action finishes its extraction');
  }else{
    if(input==='touch')g.touch('touchstart',[{identifier:41,clientX:start.x,clientY:start.y}],undefined,g.inputTime);
    else g.mouse('skin-canvas','mousedown',start.x,start.y,g.inputTime);
    assert.equal(g.state('state.tweezers.clampedPimple?.id'),p.id);
    for(let step=1;step<=16;step++){
      g.inputTime+=60;const x=start.x+direction*step*2;
      if(input==='touch')g.touch('touchmove',[{identifier:41,clientX:x,clientY:start.y}],undefined,g.inputTime);
      else g.mouse(g.w,'mousemove',x,start.y,g.inputTime);
    }
  }
  const finish=()=>{
    g.inputTime+=60;
    if(input==='keyboard')key(g,' ','keyup');
    else if(input==='touch')g.touch('touchend',[],[{identifier:41,clientX:start.x+direction*32,clientY:start.y}],g.inputTime);
    else g.mouse(g.w,'mouseup',start.x+direction*32,start.y,g.inputTime);
  };
  if(!hold)finish();
  if(settle)g.frame(16,50);
  return finish;
}

function extract(g,count,options) {for(let i=0;i<count;i++)pluck(g,nextBlack(g),options);}

function advance(g,ms) {
  let left=ms;
  while(left>0){const step=Math.min(50,left);g.clock.advance(step);g.frame(1,step);left-=step;}
}

function show(g,maximum=2500) {
  let waited=0;while(!visible(g)&&waited<maximum){advance(g,50);waited+=50;}
  assert.equal(visible(g),true,'the earned praise appears in a quiet gap');
  return praise(g).nextAt-12000;
}

function dismissByTime(g) {
  const shownAt=praise(g).nextAt-12000;
  g.clock.advance(Math.max(0,shownAt+1800-g.clock.now()));
  assert.equal(visible(g),false);
}

test('three real gentle results across mouse, touch and keyboard earn one accessible nonblocking praise without extra rewards',async t=>{
  let audioStarts=0;
  const g=await game(t,{storage:{pimple_clinic_audio_v1:'off'},setupWindow:w=>{
    w.AudioContext=class{constructor(){audioStarts++;throw new Error('Muted care must not start audio');}};
  }});
  const pores=prepare(g,{bundle:true});g.evaluate('motionPreference.matches=true;');
  for(const[index,input]of ['mouse','touch','keyboard'].entries()){
    pluck(g,pores[index],{input});
    assert.equal(praise(g).streak,index+1,'a four-strand bundle is one completed result');
    assert.equal(visible(g),false,'held input and pending timers do not flash immediate praise');
  }
  const before=plain(g.state('({score:state.score,coins:state.coins,combo:state.combo,perfectOps:state.perfectOps,runStats:state.runStats,tool:state.currentTool,paused:state.paused})'));
  const focus=g.d.activeElement,canvas=g.d.getElementById('skin-canvas');
  const shownAt=show(g);
  assert.equal(notice(g).dataset.streak,'3');
  assert.equal(notice(g).getAttribute('role'),'status');
  assert.equal(notice(g).getAttribute('aria-live'),'polite');
  const style=g.w.getComputedStyle(notice(g));
  assert.ok(['absolute','fixed'].includes(style.position),'praise stays out of the page layout');
  assert.equal(style.pointerEvents,'none','praise cannot intercept care input');
  assert.equal(notice(g).querySelector('button,a,input,[tabindex]'),null);
  assert.equal(g.d.activeElement,focus,'the current tool target retains keyboard focus');
  assert.equal(canvas.closest('[inert]'),null);
  assert.equal(g.d.querySelector('.modal-backdrop.open'),null);
  assert.deepEqual(plain(g.state('({score:state.score,coins:state.coins,combo:state.combo,perfectOps:state.perfectOps,runStats:state.runStats,tool:state.currentTool,paused:state.paused})')),before);
  assert.ok(notice(g).classList.contains('reduced-motion'));
  assert.equal(audioStarts,0,'muted extraction and praise create no audio context');
  assert.equal(praise(g).shownThisRun,1);
  assert.equal(praise(g).nextAt,shownAt+12000);
  g.clock.advance(shownAt+1799-g.clock.now());assert.equal(visible(g),true);
  g.clock.advance(1);assert.equal(visible(g),false,'the toast lasts exactly 1.8 seconds');
});

test('ledger dedup counts each fresh core once, ignores collection-only rewards and ignores whitehead results',async t=>{
  const g=await game(t),pores=prepare(g,{count:5,sequences:[3]});
  for(let index=0;index<3;index++){
    pluck(g,pores[0]);assert.equal(praise(g).streak,index+1);
  }
  const ids=plain(g.state('Object.keys(state.collectionLedger)'));
  assert.deepEqual(ids,['blackhead:1','blackhead:1:core:2','blackhead:1:core:3']);
  assert.ok(g.state('Object.values(state.collectionLedger).every(item=>item.praiseCounted===true)'));
  const before=praise(g);
  for(const id of ids)g.evaluate(`rewardTrophyOnce(${JSON.stringify(id)},'extract',999,0,0,'');
    recordBlackheadCarePraise(state.collectionLedger[${JSON.stringify(id)}]);
    rewardTrophyOnce(${JSON.stringify(id)},'collect',45,0,0,'');`);
  assert.deepEqual(praise(g),before,'repeated extract hooks and later collection do not add successes');
  pluck(g,pores.find(p=>p.type==='whitehead'));
  assert.equal(praise(g).streak,3,'a whitehead is not a blackhead milestone');
});

test('a completed squeeze group waits for physical mouse, both touch contacts or the care key after logical release',async t=>{
  for(const input of ['mouse','touch','keyboard']){
    const g=await game(t),pores=prepare(g,{count:5,white:0,cluster:true}),p=pores[0];
    const fingers=half=>[{identifier:11,clientX:p.x-half,clientY:p.y},{identifier:22,clientX:p.x+half,clientY:p.y}];
    g.click('tool-squeeze');
    if(input==='mouse'){g.mouse('skin-canvas','mousedown',p.x,p.y);g.mouse(g.w,'mousemove',p.x+28,p.y);}
    else if(input==='touch'){g.touch('touchstart',fingers(48));g.touch('touchmove',fingers(38));}
    else{select(g,p);key(g,' ');}
    let frames=0;while(g.state('Object.keys(state.collectionLedger).length')<3&&frames++<120)g.frame(1,50);
    assert.ok(frames<120,input+' completes a real neighboring group');g.frame(3,50);
    assert.equal(g.state('state.pointer.active'),false,'the group auto-releases simulation input');
    assert.equal(praise(g).streak,3,'three separate pore results count independently');
    advance(g,1000);
    assert.equal(visible(g),false,input+' remains physically held');
    assert.equal(g.state('maybeShowCarePraise()'),false);
    if(input==='touch'){
      const held=fingers(38);g.touch('touchend',[held[0]],[held[1]]);advance(g,500);
      assert.equal(visible(g),false,'one remaining finger still blocks praise');g.touch('touchend',[],[held[0]]);
    }else if(input==='mouse')g.mouse(g.w,'mouseup',p.x+28,p.y);
    else key(g,' ','keyup');
    show(g);assert.equal(praise(g).shownThisRun,1);assert.equal(praise(g).streak,3);
    assert.equal(g.state('Object.keys(state.collectionLedger).length'),3);
  }
});

test('real mistakes and nongentle blackhead results silently reset only the dedicated clean streak',async t=>{
  const g=await game(t),pores=prepare(g);
  extract(g,2);assert.equal(praise(g).streak,2);
  g.evaluate("addScore(10,0,0);addScore(10,0,0);addScore(10,0,0);addScore(10,0,0);");
  assert.ok(g.state('state.combo')>=6);assert.equal(praise(g).streak,2,'ordinary score combo is not the praise counter');
  g.click('tool-needle');g.mouse('skin-canvas','mousedown',2,2);g.mouse(g.w,'mouseup',2,2);
  assert.equal(praise(g).streak,0);assert.equal(praise(g).lastMilestone,0);assert.equal(visible(g),false);
  extract(g,2);assert.equal(praise(g).streak,2);
  const rough=nextBlack(g);rough.snappedCap=true;pluck(g,rough);
  assert.equal(g.state(`state.collectionLedger['blackhead:${rough.id}'].gentle`),false);
  assert.equal(praise(g).streak,0,'success on a previously snapped cap breaks the clean sequence');
  assert.equal(g.state('carePraisePending'),null);advance(g,1000);assert.equal(visible(g),false);
  pluck(g,nextBlack(g));assert.equal(praise(g).streak,1,'the next gentle action begins a new sequence');
  pluck(g,pores.find(p=>p.type==='whitehead'));assert.equal(praise(g).streak,1);
});

test('milestones coalesce to the latest actual count, respect twelve seconds between displays and stop after three per round',async t=>{
  const g=await game(t);prepare(g,{count:11,white:0,sequences:[4,2]});
  extract(g,3);show(g);assert.equal(notice(g).dataset.streak,'3');dismissByTime(g);
  g.clock.advance(praise(g).nextAt-g.clock.now()-700);
  extract(g,3);const expires=g.state('carePraisePending.expiresAt');
  assert.equal(praise(g).lastMilestone,6);assert.equal(visible(g),false,'the cooldown blocks the six-result milestone');
  extract(g,2);
  assert.equal(g.state('carePraisePending.streak'),8,'one candidate incorporates newer genuine successes');
  assert.equal(g.state('carePraisePending.expiresAt'),expires,'continued successes cannot renew the candidate forever');
  advance(g,699);assert.equal(visible(g),false);advance(g,1);
  assert.equal(visible(g),true);assert.equal(notice(g).dataset.streak,'8');assert.equal(praise(g).shownThisRun,2);
  dismissByTime(g);g.clock.advance(praise(g).nextAt-g.clock.now()-700);
  extract(g,2);assert.equal(praise(g).lastMilestone,10);advance(g,700);
  assert.equal(visible(g),true);assert.equal(notice(g).dataset.streak,'10');assert.equal(praise(g).shownThisRun,3);
  dismissByTime(g);g.clock.advance(12000);extract(g,5);advance(g,2000);
  assert.equal(praise(g).streak,15);assert.equal(praise(g).lastMilestone,15);
  assert.equal(praise(g).shownThisRun,3);assert.equal(visible(g),false,'a fourth milestone cannot exceed the round cap');
  assert.equal(g.state('carePraisePending'),null);
  prepare(g,{count:6,white:0,reset:false});
  assert.equal(praise(g).streak,15);assert.equal(praise(g).shownThisRun,0);
  extract(g,4);advance(g,500);assert.equal(visible(g),false,'repeat milestones are five real results apart');
  extract(g,1);show(g);assert.equal(notice(g).dataset.streak,'20');assert.equal(praise(g).shownThisRun,1);
});

test('real gift discovery takes priority and an eight-second-old candidate never replays after the gift is dismissed',async t=>{
  const g=await game(t);prepare(g,{gift:true});extract(g,3);
  assert.equal(g.d.getElementById('gift-discovery').hidden,false,'the third extraction discovers its real reward');
  advance(g,1000);assert.equal(visible(g),false,'gift flight and gift notice remain above praise');
  g.evaluate('dismissGiftNotice(true,false);');await tick();show(g);
  assert.equal(g.d.getElementById('gift-discovery').hidden,true);assert.equal(notice(g).dataset.streak,'3');
  const stale=await game(t);prepare(stale,{gift:true});extract(stale,3);
  stale.evaluate('scheduleGiftNoticeDismiss(20000);');advance(stale,8001);
  assert.equal(visible(stale),false);assert.equal(stale.state('carePraisePending'),null,'the blocked candidate expires after eight seconds');
  stale.evaluate('dismissGiftNotice(true,false);');await tick();advance(stale,1000);
  assert.equal(visible(stale),false,'clearing a long-lived gift cannot revive old praise');
  assert.equal(praise(stale).lastMilestone,3);assert.equal(praise(stale).shownThisRun,0);
  extract(stale,2);advance(stale,500);assert.equal(visible(stale),false,'non-milestone actions do not replay an expired milestone');
  extract(stale,1);show(stale);assert.equal(notice(stale).dataset.streak,'6','a new genuine milestone remains eligible');
});

test('dialogs, hunger, home, ice, background and ownership loss cancel pending praise without delayed replay',async t=>{
  const cases=[
    {name:'help',block:g=>g.click('btn-help'),restore:g=>g.click('btn-close-help')},
    {name:'hunger',block:g=>g.evaluate("wardrobeProgress.hunger=100;wardrobeProgress.pantry={food_pudding:1};hungerSafeAfter=0;maybeShowHungerReminder();"),
      restore:g=>g.click('btn-hunger-later')},
    {name:'home',block:g=>g.click('btn-adventure-home'),restore:g=>g.click('btn-start-adventure')},
    {name:'ice',block:g=>g.evaluate('state.iceFinishing=true;queueCarePraise();'),restore:g=>g.evaluate('state.iceFinishing=false;requestSceneFrame();')},
    {name:'background',block:g=>{Object.defineProperty(g.d,'hidden',{configurable:true,value:true});g.d.dispatchEvent(new g.w.Event('visibilitychange'));},
      restore:g=>{Object.defineProperty(g.d,'hidden',{configurable:true,value:false});g.d.dispatchEvent(new g.w.Event('visibilitychange'));}},
    {name:'ownership loss',block:g=>g.evaluate('careControl.owned=false;queueCarePraise();'),restore:g=>g.evaluate('careControl.owned=true;')}
  ];
  for(const item of cases){
    const g=await game(t);prepare(g);extract(g,3);
    assert.ok(g.state('carePraisePending'),item.name+' begins with a real earned candidate');
    item.block(g);await tick();
    if(item.name==='hunger')assert.ok(g.d.getElementById('hunger-modal').classList.contains('open'));
    const active=g.d.querySelector('.modal-backdrop.open')?.id||null;
    assert.equal(g.state('maybeShowCarePraise()'),false,item.name+' blocks the presentation');
    g.clock.advance(1000);await tick();
    assert.equal(visible(g),false);assert.equal(g.state('carePraisePending'),null);
    assert.equal(g.d.querySelector('.modal-backdrop.open')?.id||null,active,'praise cannot change the current flow');
    assert.equal(praise(g).shownThisRun,0,'a blocked candidate does not consume a display slot');
    item.restore(g);await tick();g.evaluate('queueCarePraise(0);');advance(g,1000);
    assert.equal(visible(g),false,item.name+' cannot replay stale praise after returning');
    assert.equal(praise(g).streak,3,'changing presentation context preserves genuine achievements');
  }
});

test('saved streak, consumed milestones, cooldown and round cap survive reload while a completed round preserves the streak',async t=>{
  const g=await game(t);prepare(g,{count:11,white:0});
  for(const count of [3,3,4]){
    if(praise(g).shownThisRun)g.clock.advance(Math.max(0,praise(g).nextAt-g.clock.now()));
    extract(g,count);show(g);dismissByTime(g);
  }
  assert.equal(praise(g).shownThisRun,3);assert.equal(praise(g).streak,10);
  g.evaluate('saveCurrentSession(true);');
  const progress=praise(g),runId=g.state('state.runId'),storage=g.storage(),now=g.clock.now();
  assert.deepEqual(saved(g).wardrobe.carePraise,progress,'the cap and cooldown are part of the same saved profile');
  g.close();
  const restored=await game(t,{storage,now});
  assert.equal(restored.state('state.runId'),runId);
  assert.deepEqual(praise(restored),progress);assert.equal(visible(restored),false);assert.equal(restored.state('carePraisePending'),null);
  assert.equal(restored.state('Object.values(state.collectionLedger).filter(item=>item.praiseCounted).length'),10);
  restored.evaluate('Object.values(state.collectionLedger).forEach(recordBlackheadCarePraise);queueCarePraise(0);');
  advance(restored,13000);
  assert.equal(praise(restored).streak,10);assert.equal(praise(restored).shownThisRun,3);assert.equal(visible(restored),false,'refresh cannot replay consumed milestones after cooldown');
  restored.evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  restored.click('btn-ice-quick');restored.frame(65);await tick();
  assert.equal(restored.state('state.settled'),true,'cross the real completion boundary');
  assert.equal(praise(restored).streak,10,'completing care preserves the achievement sequence');
  restored.click('btn-next-face');await tick();
  assert.notEqual(restored.state('state.runId'),runId);assert.equal(praise(restored).streak,10);assert.equal(praise(restored).shownThisRun,0);
  prepare(restored,{count:6,white:0,reset:false});extract(restored,5);show(restored);
  assert.equal(notice(restored).dataset.streak,'15','the next round continues at the next genuine milestone');
  const nextAt=praise(restored).nextAt;
  restored.evaluate('recordCareMistake();');
  assert.equal(praise(restored).streak,0);assert.equal(praise(restored).nextAt,nextAt,'a reset cannot evade the display cooldown');
  assert.equal(praise(restored).shownThisRun,1,'a reset cannot evade the per-round cap');
});
