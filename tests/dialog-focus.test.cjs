const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame,createStorageHub} = require('./harness.cjs');

const tick=()=>new Promise(setImmediate);
const PROFILE='pimple_clinic_profile_v3';

async function game(t,options={}) {
  const g=await createGame({seed:411,...options});
  t.after(()=>{assert.deepEqual(g.runtimeErrors,[]);g.close();});
  await tick();g.frame();return g;
}

function tab(g,shiftKey=false) {
  const e=new g.w.KeyboardEvent('keydown',{key:'Tab',shiftKey,bubbles:true,cancelable:true});
  g.d.activeElement.dispatchEvent(e);return e;
}

test('waiting and cancelling handoff keep keyboard focus on an enabled visible action',async t=>{
  const hub=createStorageHub({}, {autoFlush:false});
  const owner=await game(t,{storageHub:hub});
  const other=await game(t,{storageHub:hub});
  const resume=other.d.getElementById('btn-continue-here');
  const cancel=other.d.getElementById('btn-cancel-handoff');
  const saved=hub.snapshot()[PROFILE];
  assert.equal(other.d.activeElement,resume);
  resume.click();
  assert.equal(resume.disabled,true);
  assert.equal(cancel.hidden,false);
  assert.equal(other.d.activeElement,cancel);
  assert.equal(tab(other).defaultPrevented,true);
  assert.equal(other.d.activeElement,cancel);
  cancel.click();await tick();
  assert.equal(await other.evaluate('careControlReady'),false);
  assert.equal(cancel.hidden,true);
  assert.equal(resume.disabled,false);
  assert.equal(other.d.activeElement,resume);
  assert.equal(owner.state('careControl.owned'),true);
  assert.equal(hub.snapshot()[PROFILE],saved);
});

test('a paused page recovers external Tab focus without accepting game input',async t=>{
  const hub=createStorageHub({}, {autoFlush:false});
  await game(t,{storageHub:hub});
  const other=await game(t,{storageHub:hub});
  const resume=other.d.getElementById('btn-continue-here');
  const cancel=other.d.getElementById('btn-cancel-handoff');
  other.d.activeElement.blur();
  assert.equal(other.d.activeElement,other.d.body);
  assert.equal(tab(other).defaultPrevented,true);
  assert.equal(other.d.activeElement,resume);
  resume.click();other.d.activeElement.blur();
  assert.equal(tab(other,true).defaultPrevented,true);
  assert.equal(other.d.activeElement,cancel);
  other.d.activeElement.blur();
  const saved=hub.snapshot()[PROFILE],tool=other.state('state.currentTool');
  other.d.body.dispatchEvent(new other.w.KeyboardEvent('keydown',{key:'2',bubbles:true,cancelable:true}));
  other.click('tool-needle');
  assert.equal(other.state('state.currentTool'),tool);
  assert.equal(hub.snapshot()[PROFILE],saved);
  cancel.click();
});

test('completing a handoff returns focus to the canvas instead of the closed dialog',async t=>{
  const hub=createStorageHub({}, {autoFlush:false});
  const owner=await game(t,{storageHub:hub});
  const other=await game(t,{storageHub:hub});
  other.click('btn-continue-here');owner.close();
  assert.equal(await other.evaluate('careControlReady'),true);
  await tick();
  assert.equal(other.d.getElementById('storage-gate-modal').classList.contains('open'),false);
  assert.equal(other.d.activeElement,other.d.getElementById('skin-canvas'));
  assert.equal(other.state('careControl.owned'),true);
});

test('successful save retry restores focus after the browser drops a hidden retry control',async t=>{
  const g=await game(t);
  const write=g.w.Storage.prototype.setItem;
  g.w.Storage.prototype.setItem=function(key,value){
    if(key===PROFILE)throw new g.w.DOMException('Storage full','QuotaExceededError');
    return write.call(this,key,value);
  };
  g.click('btn-help');await tick();
  g.evaluate('saveCurrentSession(true);');
  const retry=g.d.querySelector('#help-modal .save-retry');
  assert.equal(retry.disabled,false);retry.focus();
  assert.equal(g.d.activeElement,retry);
  g.w.Storage.prototype.setItem=write;
  // Model browsers which immediately fix up focus when a containing notice
  // becomes hidden, instead of leaving activeElement on the old button.
  const descriptor=Object.getOwnPropertyDescriptor(g.w.HTMLElement.prototype,'hidden');
  Object.defineProperty(g.w.HTMLElement.prototype,'hidden',{...descriptor,set(value){
    const hadFocus=this.contains(g.d.activeElement);
    descriptor.set.call(this,value);
    if(value&&hadFocus)g.d.activeElement.blur();
  }});
  retry.click();assert.equal(await g.evaluate('careSaveRetryReady'),true);
  assert.equal(g.d.querySelector('#help-modal .save-notice').hidden,true);
  assert.equal(g.d.getElementById('help-modal').classList.contains('open'),true);
  assert.equal(g.d.activeElement,g.d.querySelector('#help-modal [data-close-modal]'));
});
