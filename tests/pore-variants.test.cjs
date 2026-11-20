const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('./harness.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const PROFILE = 'pimple_clinic_profile_v3';

async function game(t, options = {}) {
  const g = await createGame({seed:48391, ...options});
  t.after(() => {assert.deepEqual(g.runtimeErrors, []); g.close();});
  g.frame();
  g.evaluate('renderScene=()=>{};');
  return g;
}

function level(g, value) {
  g.evaluate(`wardrobeProgress.level=${value};generateLevel(0);state.paused=false;saveCurrentSession(true);`);
  g.frame();
}

function key(g, value, type = 'keydown') {
  g.d.getElementById('skin-canvas').dispatchEvent(new g.w.KeyboardEvent(type,
    {key:value, bubbles:true, cancelable:true}));
}

function select(g, id) {
  g.d.getElementById('skin-canvas').focus();
  for (let index=0; index<100; index++) {
    if (g.state('currentKeyboardTarget()?.item.id') === id) return;
    key(g, 'ArrowRight');
  }
  throw new Error(`Cannot select pore ${id}`);
}

function hold(g, seconds) {
  key(g, ' '); g.frame(Math.ceil(seconds/.05), 50); key(g, ' ', 'keyup');
}

function warm(g, p) {
  select(g, p.id); key(g, '1'); hold(g, 1.2);
  assert.equal(p.steamed, 1);
}

function squeeze(g, p) {
  select(g, p.id); key(g, '3'); key(g, ' ');
  let frames=0;
  while (p.state < 3 && frames++ < 160) g.frame(1, 50);
  key(g, ' ', 'keyup');
  assert.ok(p.state >= 3, 'real gentle squeezing empties the content');
}

function wipe(g, p) {
  select(g, p.id); key(g, '5'); hold(g, 3); g.frame(80, 50);
  assert.ok(p.state >= 4);
}

function cavity(g, id) {
  return plain(g.evaluate(`(() => {
    const p=state.pimples.find(p=>p.id===${id});
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.setTransform(state.dpr,0,0,state.dpr,0,0);renderPimple(p,false,true);ctx.restore();
    const mouth=getPimpleMouths(p)[0],d=state.dpr;
    const center=[...ctx.getImageData(Math.round(mouth.x*d),Math.round(mouth.y*d),1,1).data];
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    let area=0;for(let index=3;index<pixels.length;index+=4)if(pixels[index]>12)area++;
    return {center,area};
  })()`));
}

test('brief real heat softens a pore, and generated giant bodies are visibly longer and thicker without moving their opening', async t => {
  const g=await game(t,{width:900,height:650});level(g,5);
  const p=g.state('state.pimples.find(p=>p.blackheadSize==="giant")');
  assert.equal(p.blackheadCount,1,'odd later levels include a giant single strand');
  select(g,p.id);key(g,'1');hold(g,.8);
  assert.ok(p.steamed>=.75,'a short unupgraded heat hold reaches the real soften threshold');
  const steam=p.steamed;g.frame(10,50);assert.equal(p.steamed,steam,'released heat stops adding progress');
  const scale=plain(g.evaluate(`(() => {
    const p=state.pimples.find(p=>p.id===${p.id});
    const large=getBlackheadRenderData(p,.8),normal=getBlackheadRenderData({...p,blackheadSize:'normal'},.8);
    return {length:large.curves[0].at(-1).distFromRoot/normal.curves[0].at(-1).distFromRoot,
      thickness:large.thickness/normal.thickness};
  })()`));
  assert.ok(scale.length>2.7 && scale.thickness>2.5,'the giant is substantially larger than the same ordinary body');
  for (const [width,height] of [[320,160],[390,210],[740,180]]) {
    g.resize(width,height);g.frame();
    const bounds=plain(g.evaluate(`(() => {
      const p=state.pimples.find(p=>p.id===${p.id});
      const opening=getPimpleMouths(p),data=getBlackheadRenderData(p,1);
      return {opening,after:getPimpleMouths(p),radius:data.thickness,
        width:state.width,height:state.height,
        points:data.curves.flat().map(point=>({x:p.x+point.x,y:p.y+point.y}))};
    })()`));
    assert.deepEqual(bounds.after,bounds.opening);
    for (const point of bounds.points) {
      assert.ok(point.x>=bounds.radius && point.x<=bounds.width-bounds.radius,
        `giant x stays on ${width}×${height}`);
      assert.ok(point.y>=bounds.radius && point.y<=bounds.height-bounds.radius,
        `giant y stays on ${width}×${height}`);
    }
  }
});

test('large whitehead uses real heat, squeeze, swab and reload; its pale cavity remains until a real ice brush covers it', async t => {
  const g=await game(t);level(g,4);
  const p=g.state('state.pimples.find(p=>p.whiteheadSize==="large")'),id=p.id;
  const mouth=plain(g.state(`getPimpleMouths(state.pimples.find(p=>p.id===${id}))`));
  warm(g,p);squeeze(g,p);
  assert.equal(p.bloodDropSize,0,'gentle large-whitehead care does not force blood');
  const residue=g.state(`state.surfaceResidues.find(item=>item.collectionId==='seed:${id}')`);
  assert.ok(residue.r>3.1*2.2 && residue.wormLen>18*2.2,'the actual expelled core is a visibly large piece');
  assert.equal(g.state(`state.collectionLedger['seed:${id}'].whiteheadSize`),'large');
  wipe(g,p);
  assert.equal(p.state,5);
  assert.equal(p.iced,false);
  assert.deepEqual(plain(g.state(`getPimpleMouths(state.pimples.find(p=>p.id===${id}))`)),mouth);
  const before=cavity(g,id);
  assert.ok(before.area>35,'the cleaned opening has a substantial visible area');
  assert.ok(before.center[0]>200 && before.center[1]>145 && before.center[2]>125,'the depression is pale pink skin, not a dark hole');
  const count=g.state('state.coreSeedsCollected'),score=g.state('state.score');
  g.evaluate('saveCurrentSession(true);');const saved=g.storage();g.close();

  const r=await game(t,{storage:saved}),restored=r.state(`state.pimples.find(p=>p.id===${id})`);
  assert.equal(restored.whiteheadSize,'large');
  assert.equal(r.state(`state.collectionLedger['seed:${id}'].whiteheadSize`),'large');
  assert.equal(r.state('state.coreSeedsCollected'),count);
  assert.equal(r.state('state.score'),score);
  assert.deepEqual(cavity(r,id),before,'the shallow cavity survives an ordinary reload');
  wipe(r,restored);
  assert.equal(r.state('state.coreSeedsCollected'),count,'cleaning again does not duplicate the large core');
  for (const target of r.state('state.pimples.filter(p=>p.state<4)')) {
    warm(r,target);
    if (target.type==='blackhead') {select(r,target.id);key(r,'4');hold(r,3.6);}
    if (target.state<4) {squeeze(r,target);wipe(r,target);}
    assert.ok(target.state>=4,'the rest of the actual level is cleaned before unlocking ice');
  }
  r.click('btn-ice-finish');
  assert.equal(r.state('state.currentTool'),'ice_brush');
  r.mouse('skin-canvas','mousedown',restored.x,restored.y);
  r.mouse(r.w,'mouseup',restored.x,restored.y);
  assert.equal(restored.iced,true);
  assert.ok(cavity(r,id).area<before.area*.25,'ice visibly closes the large cavity');
});

test('variant fields accept old saves and reject malformed lengths, incompatible sizes and altered collection profiles', async t => {
  const g=await game(t);level(g,4);
  const source=JSON.parse(g.storage()[PROFILE]).session;
  const giant=source.data.pimples.find(p=>p.blackheadSize==='giant');
  const white=source.data.pimples.find(p=>p.whiteheadSize==='large');
  const shared=source.data.pimples.find(p=>p.sharedPore);
  const faults=[
    [giant.id,'blackheadLengths',[1]],
    [giant.id,'blackheadLengths',Array(giant.blackheadCount).fill(.49)],
    [giant.id,'blackheadLengths',Array(giant.blackheadCount).fill(1.61)],
    [giant.id,'blackheadLengths',Array(giant.blackheadCount).fill('1')],
    [giant.id,'blackheadSize','huge'],[giant.id,'whiteheadSize','large'],
    [white.id,'blackheadSize','giant'],[white.id,'whiteheadSize',null],
    [shared.id,'blackheadSize','giant']
  ];
  for (const [id,field,value] of faults) {
    const damaged=plain(source);damaged.data.pimples.find(p=>p.id===id)[field]=value;
    assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(damaged))})`),false,`${field} ${JSON.stringify(value)}`);
  }
  const old=plain(source);
  for (const p of [...old.data.pimples,...old.data.initialPimples]) {
    delete p.blackheadLengths;delete p.blackheadSize;delete p.whiteheadSize;
  }
  assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(old))})`),true);
  assert.equal(g.state('state.pimples.every(p=>p.blackheadSize==="normal" && p.whiteheadSize==="normal" && p.blackheadLengths.every(length=>length===1))'),true);

  level(g,4);const p=g.state('state.pimples.find(p=>p.blackheadSize==="giant")');
  warm(g,p);squeeze(g,p);g.evaluate('saveCurrentSession(true);');
  const collected=JSON.parse(g.storage()[PROFILE]).session;
  for (const field of ['blackheadSize','blackheadLengths']) {
    const damaged=plain(collected),item=damaged.data.collectionLedger[`blackhead:${p.id}`];
    item[field]=field==='blackheadSize'?'normal':Array(p.blackheadCount).fill(.7);
    assert.equal(g.evaluate(`restoreCurrentSession(${JSON.stringify(JSON.stringify(damaged))})`),false,
      'a valid-looking but mismatched collection cannot change saved appearance');
  }
});

test('skin uses a light peach-pink range while preserving visible relief across care regions', async t => {
  const g=await game(t);
  const samples=plain(g.evaluate(`(() => {
    const indices=[...new Set(CLIENTS.map(client=>client.zoneId))].map(zone=>CLIENTS.findIndex(client=>client.zoneId===zone));
    const values=[];
    for(const index of indices)for(const mode of ['realistic','creamy']) {
      state.clientIndex=index;state.styleMode=mode;renderSkinTexture();
      const image=skinCtx.getImageData(0,0,skinLayer.width,skinLayer.height),reds=[],greens=[],blues=[];
      for(let y=12;y<image.height;y+=17)for(let x=12;x<image.width;x+=17) {
        const i=(y*image.width+x)*4;reds.push(image.data[i]);greens.push(image.data[i+1]);blues.push(image.data[i+2]);
      }
      const average=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
      values.push({red:average(reds),green:average(greens),blue:average(blues),relief:Math.max(...greens)-Math.min(...greens)});
    }
    return values;
  })()`));
  for (const sample of samples) {
    assert.ok(sample.green>190 && sample.blue>180 && sample.red>sample.green,'light warm skin avoids a broad dark-brown cast');
    assert.ok(sample.red-sample.green<55 && sample.green-sample.blue<25,'the skin stays peach-pink');
    assert.ok(sample.relief>12,'light and shadow still describe the skin relief');
  }
});
