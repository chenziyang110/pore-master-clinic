const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

test('a finger outside the canvas cannot become its primary or second touch', async t => {
  const g=await createGame({legacyRecipe:true,seed:4});t.after(g.close);g.frame();
  const p=g.state('state.pimples.find(p=>p.type==="cyst")');
  const outside={identifier:11,clientX:-120,clientY:-80};
  const inside={identifier:22,clientX:p.x-45,clientY:p.y};
  const second={identifier:33,clientX:p.x+45,clientY:p.y};
  g.click('tool-squeeze');
  g.touch('touchstart',[outside,inside],[inside]);
  assert.equal(g.state('state.pointer.touchId'),22);
  assert.equal(g.state('state.pointer.mode'),'mirror-pinch');
  g.touch('touchstart',[outside,inside,second],[second]);
  assert.equal(g.state('state.pointer.secondTouchId'),33);
  assert.equal(g.state('state.pointer.mode'),'two-finger');
  g.touch('touchmove',[second,outside,inside],[outside]);
  assert.equal(g.state('state.pointer.anchorX'),p.x);
  assert.equal(g.state('state.pointer.anchorY'),p.y);
  g.touch('touchend',[outside,inside],[second]);
  assert.equal(g.state('state.pointer.active'),false);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('heat depends on held time, not the number of mouse or touch reports', async t => {
  const levels=[];
  for(const input of ['mouse','touch']) for(const reports of [0,1,8]) {
    const g=await createGame({legacyRecipe:true,seed:9});t.after(g.close);g.frame();
    const p=g.state('state.pimples[0]');
    const finger={identifier:7,clientX:p.x,clientY:p.y};
    if(input==='mouse')g.mouse('skin-canvas','mousedown',p.x,p.y,1000);
    else g.touch('touchstart',[finger],[finger],1000);
    for(let frame=1;frame<=30;frame++) {
      for(let i=1;i<=reports;i++) {
        const time=1000+(frame-1+i/reports)*1000/60;
        if(input==='mouse')g.mouse(g.w,'mousemove',p.x,p.y,time);
        else g.touch('touchmove',[finger],[finger],time);
      }
      g.frame();
    }
    levels.push(p.steamed);
    assert.ok(p.steamed>0 && p.steamed<.75);
    assert.deepEqual(g.runtimeErrors,[]);
  }
  assert.ok(Math.max(...levels)-Math.min(...levels)<.00001,levels.join(', '));
});

test('an ignored second finger cannot reset the active tweezer speed sample', async t => {
  const g=await createGame({legacyRecipe:true,seed:3});t.after(g.close);g.frame();
  const p=g.state('state.pimples.find(p=>p.type==="blackhead")');p.steamed=1;
  g.click('tool-tweezers');
  const primary={identifier:11,clientX:p.x,clientY:p.y};
  const second={identifier:22,clientX:5,clientY:5};
  g.touch('touchstart',[primary],[primary],1000);
  g.touch('touchstart',[primary,second],[second],1050);
  second.clientX=8;
  g.touch('touchmove',[primary,second],[second],1099);
  primary.clientX+=1;
  g.touch('touchmove',[primary,second],[primary],1100);
  assert.equal(p.snappedCap,false);
  assert.ok(g.state('state.tweezers.dangerRatio')<.03);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('slow and fast tweezer drags behave consistently at 30, 60 and 240 reports per second', async t => {
  for(const input of ['mouse','touch']) for(const hz of [30,60,240]) for(const speed of [120,600]) {
    const g=await createGame({legacyRecipe:true,seed:3});t.after(g.close);g.frame();
    const p=g.state('state.pimples.find(p=>p.type==="blackhead")');
    // Begin with a valid, fully softened target; the gesture itself uses DOM input.
    p.steamed=1;g.click('tool-tweezers');
    const at=distance=>({identifier:4,clientX:p.x+distance,clientY:p.y});
    if(input==='mouse')g.mouse('skin-canvas','mousedown',p.x,p.y,1000);
    else g.touch('touchstart',[at(0)],[at(0)],1000);
    for(let n=1;n<=Math.ceil(32/(speed/hz));n++) {
      const distance=Math.min(32,n*speed/hz),time=1000+distance/speed*1000;
      if(input==='mouse')g.mouse(g.w,'mousemove',p.x+distance,p.y,time);
      else g.touch('touchmove',[at(distance)],[at(distance)],time);
    }
    assert.equal(p.snappedCap,speed===600,`${input} at ${hz} Hz, ${speed}px/s`);
    assert.equal(g.state('state.runStats.snaps'),speed===600?1:0);
    if(speed===120) assert.equal(g.state('state.flyingTrophies.length'),1);
    assert.deepEqual(g.runtimeErrors,[]);
  }
});

test('swab strokes clean the same path at sparse and dense input rates', async t => {
  for(const reports of [1,8,80]) {
    const g=await createGame({legacyRecipe:true,seed:6});t.after(g.close);g.frame();g.click('tool-swab');
    const p=g.state('state.pimples.find(p=>p.type==="whitehead")');
    p.state=3;p.surfacePusMound=2;p.bloodDropSize=2;
    g.mouse('skin-canvas','mousedown',p.x-40,p.y,1000);
    for(let n=1;n<=reports;n++)g.mouse(g.w,'mousemove',p.x-40+80*n/reports,p.y,1000+800*n/reports);
    assert.ok(p.state>=4,`${reports} input reports should clean the swept target`);
    assert.equal(p.wipeProgress,1);
    assert.deepEqual(g.runtimeErrors,[]);
  }
});

test('stationary move reports do not wipe and a sparse ice stroke covers the space between reports', async t => {
  const g=await createGame({legacyRecipe:true,seed:6});t.after(g.close);g.frame();g.click('tool-swab');
  const p=g.state('state.pimples.find(p=>p.type==="whitehead")');
  p.state=3;g.mouse('skin-canvas','mousedown',p.x,p.y,1000);
  const wiped=p.wipeProgress;
  for(let n=1;n<=30;n++)g.mouse(g.w,'mousemove',p.x,p.y,1000+n*10);
  assert.equal(p.wipeProgress,wiped);
  g.mouse(g.w,'mouseup',p.x,p.y);
  g.evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.iced=false;});enterIceBrushingStage();');
  g.mouse('skin-canvas','mousedown',p.x-90,p.y,2000);
  g.mouse(g.w,'mousemove',p.x+90,p.y,2300);
  assert.equal(p.iced,true,'an ice stroke must paint its middle, not only its endpoints');
  assert.deepEqual(g.runtimeErrors,[]);
});

