const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {createGame} = require('./harness.cjs');
const {setupRound} = require('./round-fixture.cjs');

const input = process.env.PORE_GAME_INPUT || path.join(__dirname, '..', 'index.html');
const PROFILE = 'pimple_clinic_profile_v3';
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const DEFAULTS = {hair:'none',dress:'patched',skin:'natural',lashes:'natural',eyes:'natural',
  lips:'natural',hairstyle:'original',shoes:'worn',bracelet:'none',necklace:'none'};
const FOCUS = {hair:'hair',dress:'dress',skin:'face',lashes:'face',eyes:'face',lips:'face',
  hairstyle:'hair',shoes:'shoes',bracelet:'bracelet',necklace:'necklace'};

function installImageLoader(w) {
  const held = new Set(), pending = new Set();
  function finish(image) {
    pending.delete(image);
    image.complete=true;image.naturalWidth=1536;image.naturalHeight=1024;
    const event=new w.Event('load');
    image.onload?.(event);image.dispatchEvent(event);
  }
  w.Image=class extends w.EventTarget {
    constructor(){super();this.complete=false;this.naturalWidth=0;this.naturalHeight=0;this._src='';}
    set src(value){this._src=String(value);pending.add(this);queueMicrotask(()=>{
      if (![...held].some(fragment=>this._src.includes(fragment))) finish(this);
    });}
    get src(){return this._src;}
    decode(){return Promise.resolve();}
  };
  w.__imageFixture={
    hold(fragment){held.add(fragment);},
    release(fragment){held.delete(fragment);for(const image of [...pending])if(image.src.includes(fragment))finish(image);},
    get pendingSources(){return [...pending].map(image=>image.src);}
  };
}

async function visualReady(g) {
  await g.state('wardrobeVisualReady');
  await tick();
}

async function game(t, options = {}) {
  const extraSetup=options.setupWindow;
  const g = await createGame({input,seed:11019,stayHome:true,...options,setupWindow(w){
    installImageLoader(w);extraSetup?.(w);
  }});
  let closed = false;
  const close = g.close;
  g.close = () => { if (!closed) { closed = true; close(); } };
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  await visualReady(g);
  return g;
}

function ownCatalogue(g) {
  // Explicit owned inventory isolates outfit interaction. The earned-item test
  // below separately reaches this screen through reveal and real settlement.
  g.evaluate(`wardrobeProgress.unlocked=WARDROBE_ITEMS.map(item=>item.id);
    wardrobeProgress.dreams=DREAM_ITEMS.map(item=>item.id);
    renderWardrobe();saveCurrentSession(true);`);
}

async function clickOutfit(g, id) {
  const button = g.d.querySelector('#wardrobe-collection [data-equip="'+id+'"]');
  assert.ok(button && !button.disabled, id+' has an enabled owned-item control');
  button.focus();
  button.click();
  await visualReady(g);
}

function assertMainOutfit(g, equipped) {
  for (const portrait of ['home-girl','wardrobe-girl']) {
    for (const [slot,id] of Object.entries(equipped)) {
      const nodes=[...g.d.querySelectorAll('#'+portrait+' [data-dressup-slot="'+slot+'"]')];
      assert.ok(nodes.length, portrait+' includes '+slot);
      assert.ok(nodes.every(node=>node.dataset.equipped===id), portrait+' displays '+id);
    }
  }
}

function assertDetail(g, focus) {
  assert.equal(g.state('wardrobePreviewFocus'),focus);
  const detail=g.d.getElementById('wardrobe-detail');
  assert.ok(detail, 'the wardrobe has a detail preview');
  assert.equal(detail.hidden,false,'the chosen detail is visible');
  const cropped=detail.querySelector('svg.dressup-girl');
  const full=g.d.querySelector('#wardrobe-girl svg.dressup-girl');
  assert.ok(cropped && full,'the detail and main preview both render the accepted girl');
  const bounds=cropped.getAttribute('viewBox').trim().split(/\s+/).map(Number);
  const fullBounds=full.getAttribute('viewBox').trim().split(/\s+/).map(Number);
  assert.equal(bounds.length,4);
  assert.ok(bounds.every(Number.isFinite));
  assert.ok(bounds[2]>0 && bounds[3]>0);
  assert.ok(bounds[2]*bounds[3]<fullBounds[2]*fullBounds[3], 'the detail magnifies a smaller part of the same artwork');
  assert.equal(cropped.dataset.characterArt, full.dataset.characterArt);
}

test('an earned dress equips from settlement, shows its detail, persists after reload and can be removed',async t=>{
  const g=await game(t);
  g.click('btn-start-adventure');
  setupRound(g,{level:3,setup:`state.pimples[0].giftId='dress_sky';`});
  g.evaluate('state.pimples[0].state=P_STATE.OOZING;revealWardrobeFind(state.pimples[0]);saveCurrentSession(true);');
  assert.equal(g.state('wardrobeProgress.unlocked.includes("dress_sky")'),false,'a discovered gift is collected at completion');
  g.evaluate('state.pimples.forEach(p=>{p.state=P_STATE.HEALED;p.healProgress=1;});updateHUD();');
  g.click('btn-ice-quick');g.frame(65);
  assert.equal(g.state('state.settled'),true);
  assert.equal(g.state('wardrobeProgress.unlocked.includes("dress_sky")'),true);
  g.click('btn-open-wardrobe-result');
  await visualReady(g);
  await clickOutfit(g,'dress_sky');
  assert.equal(g.state('wardrobeProgress.equipped.dress'),'dress_sky');
  assertDetail(g,'dress');
  assert.match(g.d.getElementById('wardrobe-status').textContent,/蓝色公主裙/);
  assertMainOutfit(g,{...DEFAULTS,dress:'dress_sky'});
  assert.match(g.d.querySelector('#wardrobe-girl [data-dressup-slot="dress"] image').getAttribute('href'),/kawaii-dress-sky\.webp$/);
  assert.equal(JSON.parse(g.w.localStorage.getItem(PROFILE)).wardrobe.equipped.dress,'dress_sky');
  const stored=g.storage();g.close();
  const restored=await game(t,{storage:stored});
  assertMainOutfit(restored,{...DEFAULTS,dress:'dress_sky'});
  assert.deepEqual(plain(restored.state('wardrobeProgress.unlocked')),['dress_sky']);
  restored.click('btn-home-wardrobe');
  await visualReady(restored);
  await clickOutfit(restored,'dress_sky');
  assert.equal(restored.state('wardrobeProgress.equipped.dress'),'patched','clicking the selected dress removes it');
  assert.equal(JSON.parse(restored.w.localStorage.getItem(PROFILE)).wardrobe.equipped.dress,'patched');
  assert.equal(restored.state('wardrobeProgress.unlocked.includes("dress_sky")'),true,'removing the dress retains ownership');
  assertMainOutfit(restored,DEFAULTS);
});

test('every owned outfit focuses its visible detail and a second click restores only that slot',async t=>{
  const g=await game(t);ownCatalogue(g);g.click('btn-home-wardrobe');
  await visualReady(g);
  for (const item of plain(g.state('WARDROBE_ITEMS'))) {
    g.evaluate('equipWardrobeItem("reset:all")');
    await clickOutfit(g,item.id);
    const expected={...DEFAULTS,[item.slot]:item.id};
    assert.deepEqual(plain(g.state('wardrobeProgress.equipped')),expected);
    assertMainOutfit(g,expected);
    assertDetail(g,FOCUS[item.slot]);
    assert.ok(g.d.getElementById('wardrobe-status').textContent.includes(item.name),'feedback names '+item.name);
    assert.equal(g.d.activeElement.dataset.equip,item.id,'the card remains keyboard focused after render');
    assert.equal(g.d.activeElement.getAttribute('aria-pressed'),'true');
    await clickOutfit(g,item.id);
    assert.deepEqual(plain(g.state('wardrobeProgress.equipped')),DEFAULTS,'second click removes '+item.id);
    assertMainOutfit(g,DEFAULTS);
    assert.equal(g.d.activeElement.getAttribute('aria-pressed'),'false');
    assert.ok(g.state('wardrobeProgress.unlocked').includes(item.id));
  }
  // The toggle must not reset unrelated slots when a complete look is worn.
  await clickOutfit(g,'dress_sky');await clickOutfit(g,'bow_rose');await clickOutfit(g,'shoes_rose');
  await clickOutfit(g,'bow_rose');
  assert.deepEqual(plain(g.state('wardrobeProgress.equipped')),{...DEFAULTS,dress:'dress_sky',shoes:'shoes_rose'});
});

test('preview focus can return to the full figure without changing the selected outfit',async t=>{
  const g=await game(t);ownCatalogue(g);g.click('btn-home-wardrobe');
  await visualReady(g);
  await clickOutfit(g,'contacts_ocean');assertDetail(g,'face');
  const before=plain(g.state('wardrobeProgress.equipped'));
  const savedBefore=g.w.localStorage.getItem(PROFILE);
  g.evaluate('setWardrobePreviewFocus("full")');
  assert.equal(g.state('wardrobePreviewFocus'),'full');
  assert.equal(g.d.getElementById('wardrobe-detail').hidden,true);
  assert.deepEqual(plain(g.state('wardrobeProgress.equipped')),before);
  assert.equal(g.w.localStorage.getItem(PROFILE),savedBefore,'view controls never change progress');
  g.evaluate('setWardrobePreviewFocus("face");renderWardrobeDetail();');
  assertDetail(g,'face');assertMainOutfit(g,before);
});

test('dream placement and removal announce the selected item and preserve the girl’s outfit',async t=>{
  const g=await game(t);ownCatalogue(g);g.click('btn-home-wardrobe');
  await visualReady(g);
  await clickOutfit(g,'dress_peach');
  const outfit=plain(g.state('wardrobeProgress.equipped'));
  for (const item of plain(g.state('DREAM_ITEMS'))) {
    const find=()=>g.d.querySelector('[data-dream-equip="'+item.id+'"]');
    find().click();
    assert.equal(g.state('wardrobeProgress.dreamEquipped['+JSON.stringify(item.slot)+']'),item.id);
    assert.equal(find().getAttribute('aria-pressed'),'true');
    assert.ok(g.d.getElementById('wardrobe-status').textContent.includes(item.name),'placing feedback names '+item.name);
    for (const prefix of ['home','wardrobe']) assert.equal(g.d.querySelector('#'+prefix+'-dream-scene [data-dream-slot="'+item.slot+'"]').dataset.equipped,item.id);
    assert.deepEqual(plain(g.state('wardrobeProgress.equipped')),outfit);
    find().click();
    assert.equal(g.state('wardrobeProgress.dreamEquipped['+JSON.stringify(item.slot)+']'),'none');
    assert.equal(find().getAttribute('aria-pressed'),'false');
    assert.ok(g.d.getElementById('wardrobe-status').textContent.includes(item.name),'removing feedback names '+item.name);
    for (const prefix of ['home','wardrobe']) assert.equal(g.d.querySelector('#'+prefix+'-dream-scene [data-dream-slot="'+item.slot+'"]'),null);
    assert.deepEqual(plain(g.state('wardrobeProgress.equipped')),outfit);
    assert.equal(JSON.parse(g.w.localStorage.getItem(PROFILE)).wardrobe.dreamEquipped[item.slot],'none');
  }
  g.d.querySelector('[data-dream-equip="pet_kitten"]').click();
  const stored=g.storage();g.close();
  const restored=await game(t,{storage:stored});
  assert.deepEqual(plain(restored.state('wardrobeProgress.equipped')),outfit);
  assert.equal(restored.state('wardrobeProgress.dreamEquipped.pet'),'pet_kitten');
  assert.ok(restored.d.querySelector('#home-dream-scene [data-equipped="pet_kitten"]'));
});

test('a slow outfit image keeps loading feedback and cannot overwrite a newer selection',async t=>{
  const g=await game(t);ownCatalogue(g);g.click('btn-home-wardrobe');
  await visualReady(g);
  g.w.__imageFixture.hold('kawaii-dress-sky.webp');
  g.d.querySelector('[data-equip="dress_sky"]').click();
  const slowReady=g.state('wardrobeVisualReady');
  let slowSettled=false;slowReady.then(()=>{slowSettled=true;});
  await tick();
  assert.equal(slowSettled,false,'an unready costume is still pending');
  assert.ok(g.w.__imageFixture.pendingSources.some(src=>src.includes('kawaii-dress-sky.webp')));
  assert.match(g.d.getElementById('wardrobe-status').textContent,/加载|正在|准备|换装/,'the user sees the pending change');
  await clickOutfit(g,'dress_peach');
  assertMainOutfit(g,{...DEFAULTS,dress:'dress_peach'});
  assertDetail(g,'dress');
  const finalStatus=g.d.getElementById('wardrobe-status').textContent;
  assert.match(finalStatus,/蜜桃花边裙/);
  g.w.__imageFixture.release('kawaii-dress-sky.webp');
  await slowReady;await tick();
  assertMainOutfit(g,{...DEFAULTS,dress:'dress_peach'});
  assert.equal(g.d.getElementById('wardrobe-status').textContent,finalStatus,'late completion never announces the discarded outfit');
  assert.equal(JSON.parse(g.w.localStorage.getItem(PROFILE)).wardrobe.equipped.dress,'dress_peach');
});
