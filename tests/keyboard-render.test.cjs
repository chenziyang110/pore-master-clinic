const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

function key(g, value, type = 'keydown', repeat = false) {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent(type, {key:value, bubbles:true, cancelable:true, repeat}));
}
function choose(g, id) {
  for (let step=0; step<60; step++) {
    if(g.state('currentKeyboardTarget()?.item.id')===id) return;
    key(g,'ArrowRight');
  }
  throw new Error('Could not reach target '+id+' through keyboard selection');
}
function hold(g, frames, value=' ') {
  key(g,value);g.frame(frames,50);key(g,value,'keyup');
}
function care(g,p) {
  choose(g,p.id);key(g,'1');hold(g,42);
  if(p.type==='blackhead'){key(g,'4');hold(g,36);}
  else {
    if(p.type==='cyst'){key(g,'2');hold(g,2,'Enter');}
    key(g,'3');hold(g,p.type==='cyst'?100:65);
    key(g,'5');hold(g,35);
  }
}

test('keyboard uses normal tool rules to clean a blackhead, whitehead and deep target', async t=>{
  const g=await createGame({seed:4});t.after(g.close);g.frame();g.d.getElementById('skin-canvas').focus();
  for(const type of ['blackhead','whitehead','cyst']) {
    const p=g.state('state.pimples.find(p=>p.type==='+JSON.stringify(type)+')');
    care(g,p);
    assert.ok(p.state>=4, type+' should be cleaned by held tool input');
    assert.equal(g.d.getElementById('btn-care-next').hidden,true,'a cleaned keyboard target does not suggest a tool for another tutorial target');
    assert.match(g.d.getElementById('hint-banner').textContent,/这处已清理/);
  }
  assert.equal(g.state('state.controlMode'),'keyboard');
  assert.equal(g.state('state.pointer.active'),false);
  assert.equal(g.state('state.keyboardCare.active'),false);
  assert.ok(g.state('state.trophiesPlucked+state.coreSeedsCollected')>=3);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('complete keyboard care transitions to eleven fresh targets without stale accessible announcements', async t=>{
  const g=await createGame({seed:7});t.after(g.close);g.frame();g.d.getElementById('skin-canvas').focus();
  const targets=g.state('state.pimples.map(p=>({id:p.id,type:p.type}))');
  for(const p of targets)care(g,p);
  assert.equal(g.state('state.pimples.filter(p=>p.state>=P_STATE.HEALING).length'),targets.length);
  assert.equal(g.state('state.iceFinishing'),false);
  key(g,'6');assert.equal(g.state('state.currentTool'),'ice_brush');
  for(const p of targets){choose(g,p.id);hold(g,4);}
  g.frame(30,50);
  assert.equal(g.state('state.settled'),true);
  assert.ok(g.d.getElementById('result-modal').classList.contains('open'));
  assert.ok(g.state('state.coins')>0);
  assert.equal(g.state('state.pimples.every(p=>p.iced)'),true);

  // Follow the actual result controls: the previous eight-target ice status
  // must not become the accessible name of the next eleven-target treatment.
  await new Promise(setImmediate);
  g.d.querySelector('.preset-btn[data-density="11"]').click();
  g.click('btn-next-face');g.frame();
  const canvas=g.d.getElementById('skin-canvas');
  assert.equal(g.state('state.pimples.length'),11);
  assert.doesNotMatch(canvas.getAttribute('aria-label'),/\/8|已敷膜|已清理/);
  assert.equal(g.d.getElementById('keyboard-care-status').textContent,'');
  canvas.focus();key(g,'ArrowRight');
  assert.match(canvas.getAttribute('aria-label'),/2\/11.*待护理/);

  g.click('btn-help');
  await new Promise(setImmediate);
  assert.doesNotMatch(canvas.getAttribute('aria-label'),/键盘辅助 ·/,'leaving keyboard care clears the target-specific name');
  assert.equal(g.d.getElementById('keyboard-care-status').textContent,'');
  g.w.dispatchEvent(new g.w.Event('pagehide'));
  const resumed=await createGame({seed:7,storage:g.storage()});t.after(resumed.close);resumed.frame();
  const restoredCanvas=resumed.d.getElementById('skin-canvas');
  assert.doesNotMatch(restoredCanvas.getAttribute('aria-label'),/\/8|已敷膜|已清理/);
  restoredCanvas.focus();key(resumed,'ArrowRight');
  assert.match(restoredCanvas.getAttribute('aria-label'),/2\/11.*待护理/);
  assert.deepEqual(resumed.runtimeErrors,[]);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('Escape and focus loss cancel keyboard needle; assistance is kept only for the current treatment', async t=>{
  const g=await createGame({seed:9});t.after(g.close);g.frame();const canvas=g.d.getElementById('skin-canvas');canvas.focus();
  const p=g.state('state.pimples.find(p=>p.type==="cyst")');choose(g,p.id);key(g,'2');
  key(g,' ');key(g,' ', 'keydown', true);key(g,'Escape');key(g,' ','keyup');
  assert.equal(p.pierced,false);assert.equal(g.state('state.keyboardCare.active'),false);
  key(g,'Enter');g.w.dispatchEvent(new g.w.Event('blur'));key(g,'Enter','keyup');
  assert.equal(p.pierced,false);assert.equal(g.state('state.pointer.active'),false);
  key(g,'1');g.mouse('skin-canvas','mousedown',p.x,p.y);g.mouse(g.w,'mouseup',p.x,p.y);
  assert.equal(g.state('state.controlMode'),'keyboard');assert.equal(g.state('state.pointer.touchId'),null);
  assert.equal(g.state('state.runControlMode'),'keyboard');
  g.w.dispatchEvent(new g.w.Event('pagehide'));
  const resumed=await createGame({seed:9,storage:g.storage()});t.after(resumed.close);resumed.frame();
  assert.equal(resumed.state('state.runControlMode'),'keyboard','reloading keeps the active assisted run');
  resumed.click('btn-reset');
  if(resumed.d.getElementById('reset-modal').classList.contains('open'))resumed.click('btn-confirm-reset');
  resumed.frame();
  assert.equal(resumed.state('state.controlMode'),'pointer');assert.equal(resumed.state('state.runControlMode'),'pointer');
  const fresh=resumed.state('state.pimples[0]');
  resumed.mouse('skin-canvas','mousedown',fresh.x,fresh.y);resumed.mouse(resumed.w,'mouseup',fresh.x,fresh.y);
  assert.equal(resumed.state('state.runControlMode'),'pointer','a new pointer-only run gets its own classification');
  assert.deepEqual(resumed.runtimeErrors,[]);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('paused and hidden scenes do not repaint, then resume and resize render correctly', async t=>{
  const g=await createGame({seed:5});t.after(g.close);g.frame();
  g.evaluate('window.assistPaints=0;window.assistOriginalRender=renderScene;renderScene=(...args)=>{if(!args[0])window.assistPaints++;return window.assistOriginalRender(...args);};');
  g.click('btn-help');g.frame(20);assert.equal(g.state('window.assistPaints'),0);
  g.resize(420,580);g.frame(10);assert.equal(g.state('window.assistPaints'),0);
  g.click('btn-close-help');g.frame();assert.equal(g.state('window.assistPaints'),1);
  assert.equal(g.d.getElementById('skin-canvas').width,420);
  Object.defineProperty(g.d,'hidden',{configurable:true,value:true});g.d.dispatchEvent(new g.w.Event('visibilitychange'));
  g.frame(20);assert.equal(g.state('window.assistPaints'),1);
  Object.defineProperty(g.d,'hidden',{configurable:true,value:false});g.d.dispatchEvent(new g.w.Event('visibilitychange'));
  g.frame();assert.equal(g.state('window.assistPaints'),2);
  const before=g.pixels.get(g.d.getElementById('skin-canvas')).canvas.toBuffer('image/png');
  g.click('btn-style-mode');g.frame();
  const after=g.pixels.get(g.d.getElementById('skin-canvas')).canvas.toBuffer('image/png');
  assert.notDeepEqual(before,after);
  g.click('tool-needle');g.frame();assert.equal(g.state('state.currentTool'),'needle');
  assert.deepEqual(g.runtimeErrors,[]);
});
