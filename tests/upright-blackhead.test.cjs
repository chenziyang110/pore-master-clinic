const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('./harness.cjs');
const { setupRound } = require('./round-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
async function game(t, options = {}) {
  const g = await createGame({ seed: 62473, ...options });
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame();
  return g;
}

test('short old plugs and giant plugs rise vertically from one fixed opening instead of curling sideways', async t => {
  const g = await game(t, { width: 900, height: 650 });
  for (const giant of [false, true]) for (const seed of [0, .8, 2, 4.6]) {
    const samples = plain(g.evaluate(`(() => {
      const p={...state.pimples[0],linkedPore:false,blackheadCount:1,blackheadLengths:[1],
        blackheadSize:${JSON.stringify(giant ? 'giant' : 'normal')},wormTotalLen:24,wormSeed:${seed},x:450,y:350};
      return [.2,.5,1].map(progress=>computeRealisticBlackheadCurve(p,progress,17,23));
    })()`));
    let previousHeight = 0;
    for (const points of samples) {
      assert.deepEqual({ x: points[0].x, y: points[0].y }, { x: 17, y: 23 });
      const height = points[0].y - points.at(-1).y;
      assert.ok(height > previousHeight, 'continued squeezing visibly grows the upright body');
      previousHeight = height;
      for (let index = 1; index < points.length; index++) {
        assert.ok(points[index].y < points[index - 1].y, 'no hooked tip or downward-curving banana');
        assert.ok(Math.abs(points[index].x - points[0].x) <= height * .13 + .1,
          'the complete body stays close to the vertical axis');
      }
      assert.ok(height >= points.at(-1).distFromRoot * .99, 'height is real upward growth rather than coiled arc length');
    }
    assert.ok(previousHeight >= (giant ? 74 : 33), 'older small saved lengths gain the new visible floor');
  }
});

test('normal and bundled blackheads retain a readable body width while giants remain visibly distinct', async t => {
  const g = await game(t);
  const sizes = plain(g.evaluate(`(() => {
    const p={...state.pimples[0],radius:4,x:195,y:260,linkedPore:false,blackheadCount:1,
      blackheadLengths:[1],blackheadSize:'normal'};
    return {single:getBlackheadRenderData(p,1).thickness,
      bundle:getBlackheadRenderData({...p,blackheadCount:4,blackheadLengths:[1,1,1,1]},1).thickness,
      giant:getBlackheadRenderData({...p,blackheadSize:'giant'},1).thickness};
  })()`));
  assert.ok(sizes.single * 2 >= 7, 'even small legacy or resized pores produce a seven-pixel body');
  assert.ok(sizes.bundle * 2 >= 5.8, 'a bundle cannot turn its separate bodies into hair-thin lines');
  assert.ok(sizes.giant > sizes.single * 2, 'giant columns still have over twice the normal diameter');
});

test('upright giant bundles fit short mobile canvases without moving their opening', async t => {
  const g = await game(t);
  for (const [width, height] of [[320,160], [390,210], [740,180]]) {
    g.resize(width, height); g.frame();
    const data = plain(g.evaluate(`(() => {
      const p={...state.pimples[0],x:state.width*.5,y:state.height*.7,linkedPore:false,
        blackheadCount:4,blackheadLengths:[.72,1.05,1.6,.9],blackheadSize:'giant',
        tentOffsetX:0,tentOffsetY:0};
      const before=getPimpleMouths(p),render=getBlackheadRenderData(p,1);
      return {before,after:getPimpleMouths(p),thickness:render.thickness,
        curves:render.curves.map(curve=>curve.map(pt=>({x:pt.x+p.x,y:pt.y+p.y})))};
    })()`));
    assert.deepEqual(data.before, data.after, 'edge fitting never relocates the pore');
    for (const curve of data.curves) {
      assert.ok(curve.at(-1).y < curve[0].y, 'limited space does not redirect giants sideways');
      for (const point of curve) {
        assert.ok(point.x >= data.thickness && point.x <= width - data.thickness);
        assert.ok(point.y >= data.thickness && point.y <= height - data.thickness);
      }
    }
  }
});

test('partly extruded vertical bundles keep their shape after saving and resuming', async t => {
  const g = await game(t);
  setupRound(g, {level:6, setup:`Object.assign(state.pimples[0],{blackheadCount:3,
    blackheadLengths:[.8,1.15,1.5],blackheadSize:'giant',state:P_STATE.EXTRUDING,
    extrudeProgress:.62,steamed:1});`});
  const before = plain(g.state('getBlackheadRenderData(state.pimples[0])'));
  g.evaluate('saveCurrentSession(true)');
  const saved = g.storage(); g.close();
  const resumed = await game(t, {storage:saved,seed:991});
  assert.deepEqual(plain(resumed.state('getBlackheadRenderData(state.pimples[0])')), before);
});

test('ordinary singles use the same upright column renderer in flight and in the collection tray', async t => {
  const g = await game(t);
  const observations = plain(g.evaluate(`(() => {
    const output=[],draw=renderRealisticSebumFilament;
    state.collectionLedger['blackhead:sample']={blackheadCount:1,blackheadLengths:[1],blackheadSize:'normal'};
    renderRealisticSebumFilament=(context,points,thickness,...args)=>{
      output.push({root:points[0],tip:points.at(-1),thickness});
      draw(context,points,thickness,...args);
    };
    try { renderCollectedBlackheadBundle('blackhead:sample',true);renderCollectedBlackheadBundle('blackhead:sample'); }
    finally {renderRealisticSebumFilament=draw;}
    return output;
  })()`));
  assert.equal(observations.length, 2, 'ordinary plugs have no separate tiny fallback drawing');
  for (const observed of observations) {
    assert.equal(observed.root.x, observed.tip.x);
    assert.ok(observed.root.y - observed.tip.y >= 18);
    assert.ok(observed.thickness >= 3);
    assert.equal(observed.tip.hasDarkCap, true);
  }
});
