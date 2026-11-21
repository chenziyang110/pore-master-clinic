const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('./harness.cjs');
const { setupRound } = require('./round-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const EPSILON = 1e-6;

async function game(t, options = {}) {
  const g = await createGame({seed:81412, ...options});
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  // Keep the production input, physics and Canvas implementation. Individual
  // drawing checks paint explicitly instead of repainting every drag sample.
  g.evaluate('window.paintExtractionTest = renderScene; renderScene = () => {};');
  return g;
}

function target(g, {count=1, giant=false, edge=null, sequence=false}={}) {
  setupRound(g, {
    level:7, recipe:{blackhead:2,whitehead:0,cyst:0},
    setup:`
      state.practiceGuide.active=false;
      state.upgrades.steamer=false;state.upgrades.tweezers=false;
      const p=state.pimples[0];
      p.x=state.width*.52;p.y=state.height*.70;
      if(${JSON.stringify(edge)}==='left')p.x=28;
      if(${JSON.stringify(edge)}==='right')p.x=state.width-28;
      if(${JSON.stringify(edge)}==='top')p.y=45;
      if(${JSON.stringify(edge)}==='bottom')p.y=state.height-28;
      p.nx=p.x/state.width;p.ny=p.y/state.height;
      p.radius=17;p.wormTotalLen=64;p.wormSeed=.4;
      p.headOffsetX=0;p.headOffsetY=0;p.steamed=1;
      p.state=P_STATE.EXTRUDING;p.extrudeProgress=.22;
      p.blackheadCount=${count};
      p.blackheadLengths=${JSON.stringify(count===4?[.65,1,1.5,.85]:Array(count).fill(1))};
      p.blackheadSize=${JSON.stringify(giant?'giant':'normal')};
      p.poreSequence=${sequence?'{count:3,index:0}':'null'};
      const other=state.pimples[1];other.x=state.width*.8;other.y=state.height-22;
      other.nx=other.x/state.width;other.ny=other.y/state.height;
    `
  });
  return g.state('state.pimples[0]');
}

function begin(g, p, {input='mouse', tipIndex=0}={}) {
  const start=plain(g.evaluate(`(() => {
    const p=state.pimples.find(item=>item.id===${p.id});
    const tip=getBlackheadRenderData(p).curves[${tipIndex}].at(-1);
    return {x:p.x+tip.x,y:p.y+tip.y};
  })()`));
  const length=Math.hypot(start.x-p.x,start.y-p.y)||1;
  let direction={x:(start.x-p.x)/length,y:(start.y-p.y)/length};
  const width=g.state('state.width'),height=g.state('state.height');
  const end={x:start.x+direction.x*34,y:start.y+direction.y*34};
  if(end.x<8||end.x>width-8||end.y<8||end.y>height-8) {
    direction={x:start.x<width/2?1:-1,y:0};
  }
  const gesture={start,direction,input,time:1000,distance:0};
  g.click('tool-tweezers');
  if(input==='touch')g.touch('touchstart',[{identifier:41,clientX:start.x,clientY:start.y}],undefined,gesture.time);
  else g.mouse('skin-canvas','mousedown',start.x,start.y,gesture.time);
  assert.equal(g.state('state.tweezers.clampedPimple?.id'),p.id,'the visible cap is a real grab target');
  return gesture;
}

function move(g, gesture, distance) {
  while(gesture.distance<distance) {
    gesture.distance=Math.min(distance,gesture.distance+2);
    gesture.time+=60;
    const x=gesture.start.x+gesture.direction.x*gesture.distance;
    const y=gesture.start.y+gesture.direction.y*gesture.distance;
    if(gesture.input==='touch')g.touch('touchmove',[{identifier:41,clientX:x,clientY:y}],undefined,gesture.time);
    else g.mouse(g.w,'mousemove',x,y,gesture.time);
  }
}

function release(g, gesture) {
  const x=gesture.start.x+gesture.direction.x*gesture.distance;
  const y=gesture.start.y+gesture.direction.y*gesture.distance;
  gesture.time+=60;
  if(gesture.input==='touch')g.touch('touchend',[],[{identifier:41,clientX:x,clientY:y}],gesture.time);
  else g.mouse(g.w,'mouseup',x,y,gesture.time);
}

function snapshot(g, p) {
  return plain(g.evaluate(`(() => {
    const p=state.pimples.find(item=>item.id===${p.id}),tw=state.tweezers;
    const ox=p.x+(p.tentOffsetX||0),oy=p.y+(p.tentOffsetY||0);
    const data=getBlackheadRenderData(p,p.extrudeProgress,{x:tw.curTipX-ox,y:tw.curTipY-oy});
    const geometry=getTweezerExtractionGeometry(p);
    return {
      geometry,
      actualCurves:data.curves.map(curve=>curve.map(point=>({x:point.x+ox,y:point.y+oy}))),
      thickness:data.thickness,mouths:getPimpleMouths(p),
      visualTip:getTweezerVisualTip(p),
      projectedTip:projectTweezerExtractionPoint(geometry,getTweezerVisualTip(p)),
      width:state.width,height:state.height,radius:p.radius
    };
  })()`));
}

function contains(rect, point, radius=0, message='point stays visible') {
  assert.ok(point.x-radius>=rect.x-EPSILON && point.x+radius<=rect.x+rect.width+EPSILON
    && point.y-radius>=rect.y-EPSILON && point.y+radius<=rect.y+rect.height+EPSILON,
    `${message}: ${JSON.stringify({rect,point,radius})}`);
}

function assertCompleteView(observed, label) {
  const {geometry:g,actualCurves,thickness,mouths,visualTip,projectedTip,width,height,radius}=observed;
  for(const rect of [g.panel,g.view,g.source]) {
    assert.ok(Object.values(rect).every(Number.isFinite),`${label}: finite camera coordinates`);
    assert.ok(rect.width>0&&rect.height>0,`${label}: positive camera size`);
  }
  contains({x:0,y:0,width,height},{x:g.panel.x,y:g.panel.y},0,`${label}: panel top-left`);
  contains({x:0,y:0,width,height},{x:g.panel.x+g.panel.width,y:g.panel.y+g.panel.height},0,`${label}: panel bottom-right`);
  contains(g.panel,{x:g.view.x,y:g.view.y},0,`${label}: content top-left`);
  contains(g.panel,{x:g.view.x+g.view.width,y:g.view.y+g.view.height},0,`${label}: content bottom-right`);
  assert.ok(g.view.width>=160,`${label}: wider than the former 96px lens`);
  if(height>=280)assert.ok(g.view.width*g.view.height>=96*96*2,`${label}: at least twice the former viewing area`);
  assert.ok(g.zoom>0&&Number.isFinite(g.zoom),`${label}: valid fit scale`);
  assert.ok(g.rotation===0||Math.abs(Math.abs(g.rotation)-Math.PI/2)<EPSILON,`${label}: optical orientation is a quarter turn or upright`);
  const turned=Math.abs(g.rotation)>EPSILON;
  assert.ok(Math.abs(g.view.width/(turned?g.source.height:g.source.width)-g.zoom)<EPSILON,`${label}: horizontal projection scale`);
  assert.ok(Math.abs(g.view.height/(turned?g.source.width:g.source.height)-g.zoom)<EPSILON,`${label}: vertical projection scale`);
  const dx=visualTip.x-g.source.x-g.source.width/2,dy=visualTip.y-g.source.y-g.source.height/2;
  const expectedTip={x:g.view.x+g.view.width/2+g.zoom*(Math.cos(g.rotation)*dx-Math.sin(g.rotation)*dy),
    y:g.view.y+g.view.height/2+g.zoom*(Math.sin(g.rotation)*dx+Math.cos(g.rotation)*dy)};
  assert.ok(Math.hypot(expectedTip.x-projectedTip.x,expectedTip.y-projectedTip.y)<EPSILON,`${label}: displayed tip uses the optical projection`);
  contains(g.view,projectedTip,thickness*g.zoom,`${label}: displayed contact is inside the optical view`);
  for(const curve of actualCurves)for(const point of curve) {
    contains(g.source,point,thickness,`${label}: full filament body, root and cap`);
  }
  for(const mouth of mouths)contains(g.source,mouth,radius*.5,`${label}: pore opening remains in view`);
  contains(g.source,visualTip,thickness,`${label}: gripping contact remains in view`);
  const tips=actualCurves.map(curve=>curve.at(-1));
  assert.ok(Math.min(...tips.map(tip=>Math.hypot(tip.x-visualTip.x,tip.y-visualTip.y)))<EPSILON,
    `${label}: tweezer contact is on a real rendered cap`);
}

test('the larger extraction view keeps every root, cap and gripping point inside the frame across board sizes and edges',async t=>{
  // Harness dimensions describe the actual Canvas, not CSS viewport layout.
  // The short board separately exercises the constrained landscape case.
  const dimensions=[[320,568],[390,844],[844,390],[1100,760],[804,167],[320,160],[320,100]];
  const cases=[{}, {giant:true}, {giant:true,count:4},
    ...['left','right','top','bottom'].map(edge=>({giant:true,count:4,edge}))];
  for(const [width,height]of dimensions) {
    const g=await game(t,{width,height});
    for(const options of cases) {
      const p=target(g,options),gesture=begin(g,p);
      const label=`${width}×${height} ${JSON.stringify(options)}`;
      let panel,rotation;
      for(const distance of [0,16,30]) {
        move(g,gesture,distance);
        const observed=snapshot(g,p);
        assertCompleteView(observed,`${label} at ${distance}px`);
        if(width===804&&height===167&&options.giant&&options.count===4&&!options.edge) {
          assert.ok(observed.geometry.zoom>=1,`${label}: the landscape close-up must not shrink the extracted bundle`);
        }
        if(panel)assert.deepEqual(observed.geometry.panel,panel,`${label}: the frame does not jump during a pull`);
        if(rotation!==undefined)assert.equal(observed.geometry.rotation,rotation,`${label}: optical orientation stays stable during a pull`);
        panel=observed.geometry.panel;
        rotation=observed.geometry.rotation;
      }
      release(g,gesture);
    }
  }
});

test('slow mouse and touch pulls keep a stable whole extraction view and collect a four-strand giant only once',async t=>{
  for(const options of [{input:'mouse'},{input:'touch'},{input:'touch',width:804,height:167}]) {
    const {input,...dimensions}=options;
    const g=await game(t,dimensions),p=target(g,{giant:true,count:4}),gesture=begin(g,p,{input,tipIndex:2});
    if(input==='touch')g.evaluate('state.styleMode="creamy";motionPreference.matches=true;');
    const zooms=[];
    for(const distance of [0,8,16,24,30]) {
      move(g,gesture,distance);g.frame();
      const observed=snapshot(g,p);assertCompleteView(observed,`${input} ${distance}px`);
      zooms.push(observed.geometry.zoom);
    }
    assert.ok(Math.max(...zooms)/Math.min(...zooms)<1.2,'camera scale stays readable instead of chasing the growing tip');
    const jaws=plain(g.evaluate(`(() => {
      const observed=[],draw=drawTweezerBlades;
      drawTweezerBlades=(context,tip,angle,clamped)=>{
        if(clamped)observed.push({...tip});draw(context,tip,angle,clamped);
      };
      try{window.paintExtractionTest();}finally{drawTweezerBlades=draw;}
      return observed;
    })()`));
    assert.deepEqual(jaws,[snapshot(g,p).visualTip],'the actual drawn jaws grip the selected cap');
    move(g,gesture,34);release(g,gesture);
    assert.equal(g.state('state.runStats.snaps'),0,'a safe drag has no cap snap');
    assert.equal(g.state('Object.keys(state.collectionLedger).length'),1,'one bundled extraction has one reward identity');
    assert.equal(g.state('Object.values(state.collectionLedger)[0].blackheadCount'),4);
    assert.ok(g.state('state.tweezers.loupeRelease'),'the completed extraction remains visible on release');
    const result=plain(g.state('state.tweezers.loupeRelease'));
    const detached=plain(g.evaluate(`(() => {
      const observed=[],draw=renderRealisticSebumFilament;
      renderRealisticSebumFilament=(context,points,thickness,...args)=>{
        if(context===renderTweezerExtractionLoupe.sample.getContext('2d')){
          const m=context.getTransform();
          observed.push({points,thickness,transform:{a:m.a,b:m.b,c:m.c,d:m.d,e:m.e,f:m.f},
            sample:{width:context.canvas.width,height:context.canvas.height}});
        }
        draw(context,points,thickness,...args);
      };
      try{window.paintExtractionTest();}finally{renderRealisticSebumFilament=draw;}
      return observed;
    })()`));
    assert.equal(detached.length,4,'completion paints every removed strand in the close-up');
    for(const strand of detached) {
      assert.ok(Math.hypot(strand.points[0].x-result.pore.x,strand.points[0].y-result.pore.y)>4,
        'the completed root visibly separates from the pore');
      const m=strand.transform,scaleX=Math.hypot(m.a,m.b),scaleY=Math.hypot(m.c,m.d);
      assert.ok(Math.abs(scaleX-scaleY)<.02,'the real Canvas projection does not stretch the extracted plug');
      assert.ok(Math.abs(m.a*m.c+m.b*m.d)<EPSILON,'the real Canvas projection has perpendicular axes');
      for(const point of strand.points){
        contains(result.source,point,strand.thickness,'the detached result remains fully visible');
        contains({x:0,y:0,...strand.sample},{x:m.a*point.x+m.c*point.y+m.e,y:m.b*point.x+m.d*point.y+m.f},
          strand.thickness*Math.max(scaleX,scaleY),'the actual projected result remains inside the sample');
      }
    }
    g.frame(4,50);
    assert.ok(g.state('state.tweezers.loupeRelease'),'completion stays long enough to observe the detached root');
    g.frame(6,50);
    assert.equal(g.state('state.tweezers.loupeRelease'),null,'the success view expires without another action');
    assert.equal(g.state('Object.keys(state.collectionLedger).length'),1,'the success presentation cannot duplicate collection');
  }
});

test('the completion view never extracts the next core and a fresh grab replaces its frozen subject',async t=>{
  const g=await game(t),p=target(g,{sequence:true}),first=begin(g,p);
  move(g,first,34);
  assert.equal(p.poreSequence.index,1,'first pull reveals exactly the second core');
  assert.ok(g.state('state.tweezers.loupeRelease'));
  const firstLedger=plain(g.state('Object.keys(state.collectionLedger)'));
  move(g,first,48);g.frame(4,50);
  assert.equal(p.poreSequence.index,1,'holding the completed action cannot pull the new core');
  assert.deepEqual(plain(g.state('Object.keys(state.collectionLedger)')),firstLedger);
  release(g,first);
  const second=begin(g,p);
  assert.equal(g.state('state.tweezers.loupeRelease'),null,'new grip cancels the old completion presentation');
  assertCompleteView(snapshot(g,p),'next core');
  move(g,second,16);release(g,second);
  assert.equal(g.state('state.tweezers.clampedPimple'),null,'ordinary release cancels the active grip');
  assert.equal(g.state('state.tweezers.loupePlacement'),null,'ordinary release clears its locked placement');
  assert.equal(p.poreSequence.index,1,'a half pull cannot collect another core');
});

test('collection flight drawing cannot cover the held extraction close-up and resumes after it expires',async t=>{
  const g=await game(t),p=target(g,{giant:true,count:4}),gesture=begin(g,p);
  move(g,gesture,34);release(g,gesture);
  const panel=plain(g.state('state.tweezers.loupeRelease.panel'));
  const point={x:Math.round(panel.x+panel.width*.5),y:Math.round(panel.y+panel.height*.5)};
  const paintCollection=()=>plain(g.evaluate(`(() => {
    const original=renderTrophyDishAndFlyingPlugs;
    // A full-board flight-layer marker makes any overlap visible, regardless
    // of the randomized trophy trajectory in a particular playthrough.
    renderTrophyDishAndFlyingPlugs=()=>{ctx.fillStyle='#ff00ff';ctx.fillRect(0,0,state.width,state.height);};
    try{window.paintExtractionTest();}finally{renderTrophyDishAndFlyingPlugs=original;}
    return {inside:[...ctx.getImageData(${point.x},${point.y},1,1).data],
      outside:[...ctx.getImageData(state.width-1,state.height-1,1,1).data]};
  })()`));
  const during=paintCollection();
  assert.deepEqual(during.outside,[255,0,255,255],'the collection layer still draws outside the close-up');
  assert.notDeepEqual(during.inside,[255,0,255,255],'flying trophies cannot duplicate the plug over the held result');
  g.frame(12,50);
  assert.equal(g.state('state.tweezers.loupeRelease'),null);
  assert.deepEqual(paintCollection().inside,[255,0,255,255],'the collection layer is unrestricted after the view closes');
});

test('resizing cancels the old extraction framing and the needle retains its own precision lens',async t=>{
  const g=await game(t),p=target(g,{giant:true,count:4}),gesture=begin(g,p);
  move(g,gesture,16);snapshot(g,p);
  g.resize(320,180,2);g.frame();
  assert.equal(g.state('state.pointer.active'),false);
  assert.equal(g.state('state.tweezers.clampedPimple'),null);
  assert.equal(g.state('state.tweezers.loupePlacement'),null,'no stale large-board placement survives resize');
  const next=begin(g,p);assertCompleteView(snapshot(g,p),'resized board');release(g,next);
  g.click('tool-needle');
  g.mouse('skin-canvas','mousedown',160,90,5000);
  const observed=plain(g.evaluate(`(() => {
    let extractionCalls=0;const original=renderTweezerExtractionLoupe;
    renderTweezerExtractionLoupe=(...args)=>{extractionCalls++;return original(...args);};
    try{window.paintExtractionTest();}finally{renderTweezerExtractionLoupe=original;}
    return {extractionCalls,sampleWidth:renderPrecisionMagnifierLoupe.sample.width,
      expectedWidth:Math.round(CONFIG.INTERACTION.LOUPE_RADIUS_PX*2*state.dpr)};
  })()`));
  assert.equal(observed.extractionCalls,0,'needle aiming does not use the whole-extraction camera');
  assert.equal(observed.sampleWidth,observed.expectedWidth,'the existing needle lens scale is retained');
  g.mouse(g.w,'mouseup',160,90,5060);
});
