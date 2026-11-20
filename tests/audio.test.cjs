const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame, createStorageHub} = require('./harness.cjs');

// Observe Web Audio scheduling and resource lifetime without claiming that a
// synthetic node graph measures perceived loudness or real speaker quality.
function installAudio(w, {rejectResume = false, stallFirstResume = false, asyncResume = false, manualResume = false} = {}) {
  const contexts = [];
  class Param {
    constructor(value = 0) { this.value = value; this.events = []; }
    setValueAtTime(value, time) { this.events.push(['set', value, time]); this.value = value; }
    setTargetAtTime(value, time, constant) { this.events.push(['target', value, time, constant]); this.value = value; }
    linearRampToValueAtTime(value, time) { this.events.push(['linear', value, time]); this.value = value; }
    exponentialRampToValueAtTime(value, time) { this.events.push(['exponential', value, time]); this.value = value; }
    cancelScheduledValues(time) { this.events.push(['cancel', time]); }
  }
  class Node {
    constructor(ctx, kind) {
      this.ctx = ctx; this.kind = kind; this.connections = []; this.disconnected = false;
      if (kind === 'gain') this.gain = new Param(1);
      if (kind === 'oscillator' || kind === 'filter') this.frequency = new Param(440);
      if (kind === 'filter') this.Q = new Param(1);
      if (kind === 'panner') this.pan = new Param();
      if (kind === 'compressor') for (const field of ['threshold','knee','ratio','attack','release']) this[field] = new Param();
      if (kind === 'buffer') this.buffer = null;
      ctx.nodes.push(this);
    }
    connect(node) { this.connections.push(node); return node; }
    disconnect() { this.disconnected = true; this.connections = []; }
    start(time = 0, offset, duration) { this.started = time; if (duration) this.end = time + duration; }
    stop(time = 0) { this.end = time; this.stops = (this.stops || []).concat(time); }
  }
  w.AudioContext = class {
    constructor() {
      this.currentTime = 0; this.sampleRate = 8000; this.state = 'suspended';
      this.nodes = []; this.destination = {kind:'destination'}; this.resumes = 0; this.suspends = 0;
      this.pendingResumes = [];
      contexts.push(this);
    }
    createGain() { return new Node(this, 'gain'); }
    createOscillator() { return new Node(this, 'oscillator'); }
    createBufferSource() { return new Node(this, 'buffer'); }
    createBiquadFilter() { return new Node(this, 'filter'); }
    createDynamicsCompressor() { return new Node(this, 'compressor'); }
    createStereoPanner() { return new Node(this, 'panner'); }
    createBuffer(channels, length) { return {getChannelData:() => new Float32Array(length)}; }
    resume() {
      this.resumes++;
      if (rejectResume) return Promise.reject(new Error('gesture rejected'));
      if (stallFirstResume && this.resumes === 1) { this.state = 'interrupted'; return new Promise(() => {}); }
      if (manualResume) return new Promise((resolve, reject) => this.pendingResumes.push({resolve, reject}));
      if (asyncResume) return Promise.resolve().then(() => { this.state = 'running'; });
      this.state = 'running'; return Promise.resolve();
    }
    suspend() { this.suspends++; this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    finishResume(success = true) {
      const pending = this.pendingResumes.shift();
      if (!pending) throw new Error('No pending resume');
      if (success) { this.state = 'running'; pending.resolve(); }
      else pending.reject(new Error('gesture rejected'));
    }
    advance(time) {
      this.currentTime += time;
      for (const node of this.nodes) if (node.end <= this.currentTime && node.onended) node.onended();
    }
  };
  return contexts;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const waitForAudioIdle = () => new Promise(resolve => setTimeout(resolve, 220));

test('muting cancels queued sounds, suspends audio, and persists the visible preference', async t => {
  let contexts;
  const g = await createGame({seed:13, setupWindow:w => { contexts = installAudio(w); }});
  t.after(g.close);
  assert.equal(contexts.length, 0, 'loading never starts an audio context');
  g.evaluate('sound.unlock(); sound.playCleanChime(true);');
  const audio = contexts[0];
  assert.equal(g.state('sound.voices.size'), 5);
  g.click('btn-sound');
  assert.equal(g.d.getElementById('btn-sound').getAttribute('aria-pressed'), 'false');
  assert.equal(g.storage().pimple_clinic_audio_v1, 'off');
  assert.ok(audio.nodes.filter(node => node.kind === 'oscillator' && node.end !== undefined).every(node => node.end <= 0.02), 'future chime notes stop before their scheduled start');
  await waitForAudioIdle();
  assert.equal(audio.state, 'suspended');
  assert.equal(g.state('sound.voices.size'), 0);
  g.evaluate('sound.playPop(); sound.playTrayClink(); sound.setTension(1);');
  assert.equal(audio.state, 'suspended');
  assert.equal(g.state('sound.voices.size'), 0);
  const restored = await createGame({seed:13, storage:g.storage(), setupWindow:w => installAudio(w)});
  t.after(restored.close);
  assert.equal(restored.d.getElementById('sound-icon').textContent, '音效关');
  assert.equal(restored.state('sound.ctx'), null);
  g.click('btn-sound'); await tick();
  assert.equal(audio.state, 'running');
  assert.equal(g.d.getElementById('btn-sound').getAttribute('aria-label'), '关闭音效');
  assert.deepEqual(g.runtimeErrors, []);
});

test('blur, hidden pages and paused dialogs stop audio until the next care gesture', async t => {
  let contexts;
  const g = await createGame({seed:3, setupWindow:w => { contexts = installAudio(w); }});
  t.after(g.close);
  g.evaluate('sound.unlock(); sound.setTension(0.7); sound.playTrayClink();');
  const audio = contexts[0];
  g.w.dispatchEvent(new g.w.Event('blur'));
  await waitForAudioIdle();
  g.evaluate('sound.playCleanChime(); sound.setTension(0.7);');
  assert.equal(audio.state, 'suspended');
  assert.equal(g.state('sound.voices.size'), 0);
  g.mouse('skin-canvas', 'mousedown', 10, 10); await tick();
  assert.equal(audio.state, 'running');
  g.click('btn-help'); await waitForAudioIdle();
  assert.equal(audio.state, 'suspended');
  g.evaluate('sound.playTrayClink();');
  assert.equal(g.state('sound.voices.size'), 0);
  g.click('btn-close-help');
  g.mouse('skin-canvas', 'mousedown', 10, 10); await tick();
  assert.equal(audio.state, 'running');
  Object.defineProperty(g.d, 'hidden', {configurable:true, value:true});
  g.d.dispatchEvent(new g.w.Event('visibilitychange'));
  await waitForAudioIdle();
  assert.equal(audio.state, 'suspended');
  Object.defineProperty(g.d, 'hidden', {configurable:true, value:false});
  g.d.dispatchEvent(new g.w.Event('visibilitychange'));
  g.evaluate('sound.playPop();');
  assert.equal(audio.state, 'suspended', 'returning alone does not restart audio');
  g.mouse('skin-canvas', 'mousedown', 10, 10); await tick();
  assert.equal(audio.state, 'running');
  assert.deepEqual(g.runtimeErrors, []);
});

test('dense effects stay bounded, have a brief attack, and release nodes when finished', async t => {
  let contexts;
  const g = await createGame({seed:21, setupWindow:w => { contexts = installAudio(w); }});
  t.after(g.close);
  g.evaluate('sound.unlock(); for (let i=0;i<30;i++) sound.playPop("core_plug");');
  const audio = contexts[0];
  assert.equal(g.state('sound.voices.size'), 12);
  const started = audio.nodes.filter(node => node.started !== undefined && node.end !== undefined);
  assert.equal(started.length, 12, 'extra voices are not started');
  const destinationInputs = audio.nodes.filter(node => node.connections.includes(audio.destination));
  assert.equal(destinationInputs.length, 1);
  assert.equal(destinationInputs[0].kind, 'compressor', 'all effects pass through the shared output control');
  const effectGains = audio.nodes.filter(node => node.kind === 'gain' && node.gain.events[0]?.[0] === 'set');
  assert.ok(effectGains.length >= 12);
  for (const gain of effectGains) {
    const [start, attack] = gain.gain.events;
    assert.ok(start[1] < attack[1]);
    assert.equal(attack[0], 'linear');
    assert.ok(attack[2] > start[2], 'the waveform does not start at full gain');
  }
  audio.advance(1);
  assert.equal(g.state('sound.voices.size'), 0);
  assert.ok(started.every(node => node.disconnected));
  await waitForAudioIdle();
  assert.equal(audio.state, 'suspended', 'an idle audio graph stops processing');
  assert.deepEqual(g.runtimeErrors, []);
});

test('sound preferences synchronize without another page restarting audio', async t => {
  const storageHub = createStorageHub({}, {autoFlush:false});
  t.after(() => storageHub.close());
  const a = await createGame({seed:17, storageHub, setupWindow:w => installAudio(w)}); t.after(a.close);
  const b = await createGame({seed:17, storageHub, setupWindow:w => installAudio(w)}); t.after(b.close);
  a.click('btn-sound'); storageHub.flush();
  assert.equal(b.d.getElementById('sound-icon').textContent, '音效关');
  assert.equal(b.state('sound.ctx'), null);
  a.click('btn-sound'); storageHub.flush();
  assert.equal(b.d.getElementById('sound-icon').textContent, '音效开');
  assert.equal(b.state('sound.ctx'), null);
  assert.deepEqual(a.runtimeErrors, []); assert.deepEqual(b.runtimeErrors, []);
});

test('audio resume denial and unavailable preference storage do not break game controls', async t => {
  const g = await createGame({seed:31, setupWindow:w => installAudio(w, {rejectResume:true})});
  t.after(g.close);
  g.evaluate('sound.unlock(); sound.playPierce();'); await tick();
  assert.equal(g.state('sound.voices.size'), 0, 'denied audio does not accumulate effects to replay later');
  g.evaluate('window.originalAudioStorage = Storage.prototype.setItem; Storage.prototype.setItem = function(key,value) { if(key === AUDIO_PREFERENCE_KEY) throw new Error("unavailable"); return window.originalAudioStorage.call(this,key,value); };');
  g.click('btn-sound');
  assert.equal(g.d.getElementById('sound-icon').textContent, '音效关');
  g.click('btn-sound'); await tick();
  g.click('tool-needle');
  assert.equal(g.state('state.currentTool'), 'needle');
  assert.deepEqual(g.runtimeErrors, []);
});

test('a fresh gesture retries an interrupted context even when the old resume is unresolved', async t => {
  let contexts;
  const g = await createGame({seed:6, setupWindow:w => { contexts = installAudio(w, {stallFirstResume:true}); }});
  t.after(g.close);
  g.evaluate('sound.unlock(); sound.playCleanChime();');
  assert.equal(contexts[0].state, 'interrupted');
  assert.equal(g.state('sound.voices.size'), 0);
  g.mouse('skin-canvas', 'mousedown', 10, 10); await tick();
  assert.equal(contexts[0].resumes, 2);
  assert.equal(contexts[0].state, 'running');
  assert.equal(g.state('sound.voices.size'), 1, 'the fresh steam gesture plays without the old interrupted chime');
  assert.equal(g.state('sound.pendingEffects.length'), 0);
  assert.deepEqual(g.runtimeErrors, []);
});

test('a one-shot survives asynchronous audio startup and the first gesture after idle', async t => {
  let contexts;
  const g = await createGame({seed:11, setupWindow:w => { contexts = installAudio(w, {asyncResume:true}); }});
  t.after(g.close);
  g.evaluate('sound.unlock(); sound.playPierce();');
  assert.equal(contexts[0].state, 'suspended');
  await tick();
  assert.equal(g.state('sound.voices.size'), 1, 'the first needle sound starts when resume succeeds');
  contexts[0].advance(0.1); await waitForAudioIdle();
  assert.equal(contexts[0].state, 'suspended');
  g.evaluate('sound.unlock(); sound.playPierce();');
  await tick();
  assert.equal(g.state('sound.voices.size'), 1, 'the first needle sound after idle is retained too');
  assert.deepEqual(g.runtimeErrors, []);
});

test('a delayed tray landing resumes idle audio without another pointer gesture', async t => {
  let contexts;
  const g = await createGame({seed:12, setupWindow:w => { contexts = installAudio(w, {asyncResume:true}); }});
  t.after(g.close);
  g.evaluate('sound.unlock(); sound.playPop("tweeze_pluck");'); await tick();
  contexts[0].advance(0.2); await waitForAudioIdle();
  assert.equal(contexts[0].state, 'suspended');
  g.evaluate('sound.playTrayClink();'); await tick();
  assert.equal(g.state('sound.voices.size'), 2, 'both notes of a landing clink survive async resume');
  assert.deepEqual(g.runtimeErrors, []);
});

test('muting, backgrounding, dialogs and page handoff invalidate effects awaiting resume', async t => {
  const transitions = {
    muted:g => g.click('btn-sound'),
    blurred:g => g.w.dispatchEvent(new g.w.Event('blur')),
    hidden:g => {
      Object.defineProperty(g.d, 'hidden', {configurable:true, value:true});
      g.d.dispatchEvent(new g.w.Event('visibilitychange'));
    },
    dialog:g => g.click('btn-help'),
    handoff:g => g.evaluate('pauseForOtherPage("护理已在另一页面继续。");')
  };
  for (const [name, transition] of Object.entries(transitions)) {
    await t.test(name, async t => {
      let contexts;
      const g = await createGame({seed:18, setupWindow:w => { contexts = installAudio(w, {manualResume:true}); }});
      t.after(g.close);
      g.evaluate('sound.unlock(); sound.playCleanChime(true);');
      assert.equal(g.state('sound.pendingEffects.length'), 1);
      transition(g);
      // The platform resolves the old resume only after the page became silent.
      contexts[0].finishResume(); await tick();
      assert.equal(g.state('sound.voices.size'), 0);
      assert.equal(g.state('sound.pendingEffects.length'), 0);
      assert.equal(contexts[0].state, 'suspended', 'a late resolve does not leave the audio processor awake');
      assert.deepEqual(g.runtimeErrors, []);
    });
  }
});

test('pending one-shots are bounded, expire quickly, and do not survive a failed resume', async t => {
  let contexts, clock = 0;
  const g = await createGame({seed:26, setupWindow:w => {
    contexts = installAudio(w, {manualResume:true});
    Object.defineProperty(w.performance, 'now', {configurable:true, value:() => clock});
  }});
  t.after(g.close);
  g.evaluate('sound.unlock(); for (let i=0; i<30; i++) sound.playPierce();');
  assert.equal(g.state('sound.pendingEffects.length'), 8);
  clock = 251;
  contexts[0].finishResume(); await tick();
  assert.equal(g.state('sound.voices.size'), 0, 'feedback older than 250 ms is discarded');
  assert.equal(g.state('sound.pendingEffects.length'), 0);
  contexts[0].suspend();
  g.evaluate('sound.unlock(); sound.playCleanChime();');
  contexts[0].finishResume(false); await tick();
  assert.equal(g.state('sound.pendingEffects.length'), 0);
  g.evaluate('sound.unlock(); sound.playPierce();');
  clock += 20;
  contexts[0].finishResume(); await tick();
  assert.equal(g.state('sound.voices.size'), 1, 'only the fresh needle feedback follows the retry');
  assert.deepEqual(g.runtimeErrors, []);
});

test('home and wardrobe rendering or synthetic clicks never unlock audio', async t => {
  let contexts;
  const g = await createGame({seed:39, stayHome:true, setupWindow:w => { contexts = installAudio(w); }});
  t.after(g.close);
  g.click('btn-home-wardrobe');
  g.evaluate(`wardrobeProgress.unlocked=['dress_sky','mask_pearl'];renderWardrobe();`);
  g.d.querySelector('[data-equip="dress_sky"]').click();
  g.d.querySelector('[data-equip="mask_pearl"]').click();
  g.click('btn-close-wardrobe');
  g.click('btn-start-adventure');
  g.evaluate('sound.playGiftFound();renderWardrobe();');
  assert.equal(contexts.length,0,'normal initialization and programmatic events stay silent');
  assert.equal(g.state('sound.ctx'),null);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('a trusted wardrobe activation sounds while paused without unlocking care effects', async t => {
  let contexts;
  const g = await createGame({seed:41, stayHome:true, setupWindow:w => { contexts = installAudio(w); }});
  t.after(g.close);
  // jsdom cannot manufacture trusted DOM events. Pass an explicit trusted
  // activation fixture to the same handlers; browser QA uses actual clicks.
  g.evaluate(`window.audioGesture={isTrusted:true,type:'click'};openWardrobe(window.audioGesture);`);
  assert.equal(contexts.length,1);
  assert.equal(g.state('state.paused'),true);
  assert.equal(g.state('sound.canPlay()'),false);
  assert.equal(g.state('sound.blocked'),true,'UI activation does not clear the care block');
  assert.ok(g.state('sound.voices.size')>0);
  assert.equal(g.state('[...sound.voices].every(voice=>voice.scope==="ui")'),true);
  contexts[0].advance(1);
  g.evaluate('sound.playPop();sound.playGiftFound();sound.setTension(1);sound.playSteam();');
  assert.equal(g.state('sound.voices.size'),0,'paused care and delayed gift effects cannot ride the UI scope');
  const slots = ['dress','skin','hair','shoes'];
  g.evaluate(`wardrobeProgress.unlocked=['dress_sky','mask_pearl','bow_rose','shoes_rose'];renderWardrobe();`);
  for (const [index,id] of ['dress_sky','mask_pearl','bow_rose','shoes_rose'].entries()) {
    g.evaluate(`equipWardrobeItem(${JSON.stringify(id)},window.audioGesture);`);
    assert.equal(g.state(`wardrobeProgress.equipped.${slots[index]}`),id);
    assert.equal(g.state('[...sound.voices].every(voice=>voice.scope==="ui")'),true);
    assert.equal(g.state('sound.voices.size'),2,'each outfit action uses a small layered cue');
    contexts[0].advance(1);
  }
  await waitForAudioIdle();
  assert.equal(contexts[0].state,'suspended','UI-only activity also returns to an idle graph');
  assert.deepEqual(g.runtimeErrors,[]);
});

test('wardrobe activation replaces a pending care resume without resurrecting its sound', async t => {
  let contexts;
  const g = await createGame({seed:43, setupWindow:w => { contexts = installAudio(w,{manualResume:true}); }});
  t.after(g.close);
  g.evaluate('sound.unlock();sound.playCleanChime(true);');
  assert.equal(g.state('sound.pendingEffects.length'),1);
  g.evaluate(`openWardrobe({isTrusted:true,type:'click'});`);
  assert.equal(contexts[0].pendingResumes.length,2);
  assert.equal(g.state('sound.pendingEffects.length'),1);
  assert.equal(g.state('sound.pendingEffects[0].scope'),'ui');
  contexts[0].finishResume(); await tick();
  assert.equal(g.state('sound.voices.size'),0,'the stale care resume does not play or consume the UI cue');
  contexts[0].finishResume(); await tick();
  assert.equal(g.state('sound.voices.size'),2);
  assert.equal(g.state('[...sound.voices].every(voice=>voice.scope==="ui")'),true);
  assert.equal(g.state('sound.pendingEffects.length'),0);
  assert.deepEqual(g.runtimeErrors,[]);
});

test('UI feedback awaiting resume is cancelled by mute, blur, background, help and handoff', async t => {
  const transitions = {
    muted:g=>g.click('btn-sound'),
    blurred:g=>g.w.dispatchEvent(new g.w.Event('blur')),
    hidden:g=>{Object.defineProperty(g.d,'hidden',{configurable:true,value:true});g.d.dispatchEvent(new g.w.Event('visibilitychange'));},
    help:g=>{g.click('btn-close-wardrobe');g.click('btn-help');},
    handoff:g=>g.evaluate('pauseForOtherPage();')
  };
  for(const [name,transition] of Object.entries(transitions))await t.test(name,async t=>{
    let contexts;
    const g=await createGame({seed:47,setupWindow:w=>{contexts=installAudio(w,{manualResume:true});}});
    t.after(g.close);
    g.evaluate(`openWardrobe({isTrusted:true,type:'click'});`);
    assert.equal(g.state('sound.pendingEffects[0].scope'),'ui');
    transition(g);
    contexts[0].finishResume();await tick();
    assert.equal(g.state('sound.pendingEffects.length'),0);
    assert.equal(g.state('sound.voices.size'),0);
    assert.equal(contexts[0].state,'suspended');
    assert.deepEqual(g.runtimeErrors,[]);
  });
});

test('steam sustains one shared noise voice and fades on release or a missing input refresh', async t => {
  let contexts;
  const g=await createGame({seed:51,setupWindow:w=>{contexts=installAudio(w);}});
  t.after(g.close);
  g.evaluate('sound.unlock();sound.playSteam(.1);');
  const audio=contexts[0];
  const source=audio.nodes.find(node=>node.kind==='buffer'&&node.started!==undefined);
  assert.ok(source.loop);
  for(let i=0;i<30;i++){
    audio.advance(.05);
    g.evaluate('sound.playSteam(.9);');
    assert.equal(g.state('sound.voices.size'),1);
  }
  assert.equal(audio.nodes.filter(node=>node.kind==='buffer'&&node.started!==undefined).length,1,
    'holding steam reuses the source and shared noise buffer');
  const panner=audio.nodes.find(node=>node.kind==='panner');
  assert.ok(Math.abs(panner.pan.value)<=.2,'the spatial image stays near the center');
  g.evaluate('releasePointer();');
  assert.ok(source.end<=audio.currentTime+.041);
  audio.advance(.05);
  assert.equal(g.state('sound.voices.size'),0);
  g.evaluate('sound.playSteam(.5);');
  audio.advance(.34);
  assert.equal(g.state('sound.voices.size'),0,'a lost release cannot leave a looping hiss running');
  await waitForAudioIdle();
  assert.equal(audio.state,'suspended');
  assert.deepEqual(g.runtimeErrors,[]);
});

test('a gift cue follows its first real discovery and stays bounded with dense care feedback', async t => {
  let contexts;
  const g=await createGame({seed:53,setupWindow:w=>{contexts=installAudio(w);}});
  t.after(g.close);
  g.evaluate(`wardrobeProgress.level=3;generateLevel(0);state.paused=false;
    state.pimples[0].giftId='necklace_star';state.pimples[0].state=P_STATE.OOZING;
    sound.unlock();revealWardrobeFind(state.pimples[0]);`);
  assert.equal(g.state('sound.voices.size'),4);
  assert.equal(g.state('[...sound.voices].every(voice=>voice.scope==="care")'),true);
  g.evaluate('revealWardrobeFind(state.pimples[0]);');
  assert.equal(g.state('sound.voices.size'),4,'the same discovery does not chime twice');
  g.evaluate('for(let i=0;i<25;i++){sound.playPop("core_plug");sound.playGiftFound();}');
  assert.equal(g.state('sound.voices.size'),12);
  const audio=contexts[0];
  assert.equal(audio.nodes.filter(node=>node.connections.includes(audio.destination)).length,1);
  assert.equal(audio.nodes.find(node=>node.connections.includes(audio.destination)).kind,'compressor');
  for(const node of audio.nodes.filter(node=>node.kind==='gain')) {
    const attacks=node.gain.events.filter(event=>event[0]==='linear');
    assert.ok(attacks.every(event=>event[1]<=.15),'effect peaks use the quieter mix before the shared limiter');
  }
  audio.advance(2);
  assert.equal(g.state('sound.voices.size'),0);
  assert.ok(audio.nodes.filter(node=>node.kind==='panner').every(node=>node.disconnected));
  assert.deepEqual(g.runtimeErrors,[]);
});

test('new UI audio keeps its bounded pending lifetime and works without stereo-panner support', async t => {
  let contexts,clock=0;
  const g=await createGame({seed:59,stayHome:true,setupWindow:w=>{
    contexts=installAudio(w,{manualResume:true});
    delete w.AudioContext.prototype.createStereoPanner;
    Object.defineProperty(w.performance,'now',{configurable:true,value:()=>clock});
  }});
  t.after(g.close);
  g.evaluate(`openWardrobe({isTrusted:true,type:'click'});`);
  clock=251;
  contexts[0].finishResume();await tick();
  assert.equal(g.state('sound.voices.size'),0,'an old UI click is not replayed when resume takes too long');
  contexts[0].suspend();
  g.evaluate(`sound.playUI('outfit',{isTrusted:true,type:'click'},{slot:'hair'});`);
  clock+=20;
  contexts[0].finishResume();await tick();
  assert.equal(g.state('sound.voices.size'),2);
  assert.equal(contexts[0].nodes.filter(node=>node.kind==='panner').length,0);
  assert.deepEqual(g.runtimeErrors,[]);
});

