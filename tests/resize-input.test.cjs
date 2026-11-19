const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

test('unchanged resize events keep held care; geometry, effective DPR and forced refresh safely cancel without losing progress', async t => {
  let notifyBoardResize;
  const g = await createGame({legacyRecipe:true,seed:4,width:390,height:550,dpr:3,setupWindow(w) {
    // The harness has no CSS layout; expose the observer notification so this
    // test can model both repeated notifications and an internal height change.
    w.ResizeObserver = class {
      constructor(callback) { this.callback = callback; }
      observe(target) {
        notifyBoardResize = () => this.callback([{target,contentRect:target.getBoundingClientRect()}]);
        notifyBoardResize();
      }
    };
  }});
  t.after(() => { assert.deepEqual(g.runtimeErrors, []); g.close(); });
  g.frame(2);
  const black = g.state('state.pimples.find(p=>p.type==="blackhead")');
  g.mouse('skin-canvas','mousedown',black.x,black.y);
  g.frame(3);
  const warmth = black.steamed;
  g.w.dispatchEvent(new g.w.Event('resize'));
  notifyBoardResize();g.frame(3);
  assert.equal(g.state('state.pointer.active'),true);
  assert.ok(black.steamed>warmth,'held heating continues across redundant notifications');
  g.mouse(g.w,'mouseup',black.x,black.y);

  g.click('tool-needle');
  const deep = g.state('state.pimples.find(p=>p.type==="cyst")');
  const touch = p => ({identifier:7,clientX:p.x,clientY:p.y});
  const first = touch(deep);
  g.touch('touchstart',[first],[first]);
  g.w.dispatchEvent(new g.w.Event('resize'));
  notifyBoardResize();g.frame();
  assert.equal(g.state('state.pointer.active'),true);
  assert.equal(deep.pierced,false);
  g.touch('touchend',[],[first]);
  assert.equal(deep.pierced,true,'the original needle release still completes exactly once');

  const progress = {run:g.state('state.runId'),score:g.state('state.score'),warmth:black.steamed};
  const white = g.state('state.pimples.find(p=>p.type==="whitehead")');
  const assertProgress = () => {
    assert.equal(g.state('state.runId'),progress.run);
    assert.equal(g.state('state.score'),progress.score);
    assert.equal(black.steamed,progress.warmth);
    assert.equal(deep.pierced,true);
    assert.equal(white.pierced,false);
    assert.equal(g.state('state.runStats.mistakes'),0);
    assert.equal(g.state('state.damage'),0);
  };
  for (const [width,height,dpr] of [[666,197,3],[666,197,2]]) {
    const finger = touch(white);
    g.touch('touchstart',[finger],[finger]);
    g.resize(width,height,dpr);
    assert.equal(g.state('state.pointer.active'),false);
    g.touch('touchend',[],[finger]);
    assertProgress();
    assert.equal(g.d.getElementById('skin-canvas').width,Math.floor(width*Math.min(dpr,2.5)));
  }

  g.resize(666,197,3);
  const capped = touch(white);
  g.touch('touchstart',[capped],[capped]);
  g.resize(666,197,4);notifyBoardResize();g.frame();
  assert.equal(g.state('state.pointer.active'),true,'DPR values above the same render cap do not change the surface');
  g.touch('touchcancel',[],[capped]);assertProgress();

  const wrap = g.d.getElementById('viewport-wrap');
  const nativeRect = wrap.getBoundingClientRect;
  const held = touch(white);
  g.touch('touchstart',[held],[held]);
  wrap.getBoundingClientRect = function() {
    const rect = nativeRect.call(this);
    return {...rect,height:rect.height+18,bottom:rect.bottom+18};
  };
  notifyBoardResize();g.frame();
  assert.equal(g.state('state.height'),215);
  assert.equal(g.state('state.pointer.active'),false,'a real internal resize retains the safe cancellation');
  g.touch('touchend',[],[held]);assertProgress();
  wrap.getBoundingClientRect = nativeRect;
  g.resize(666,197,4);

  const canvas = g.d.getElementById('skin-canvas');
  const nativeCanvasRect = canvas.getBoundingClientRect;
  const oldClientPoint = {x:white.x,y:white.y};
  g.mouse('skin-canvas','mousedown',oldClientPoint.x,oldClientPoint.y);
  for (const [element,read] of [[wrap,nativeRect],[canvas,nativeCanvasRect]]) {
    element.getBoundingClientRect = function() {
      const rect = read.call(this);
      return {...rect,x:rect.x+80,left:rect.left+80,right:rect.right+80,y:rect.y+12,top:rect.top+12,bottom:rect.bottom+12};
    };
  }
  g.w.dispatchEvent(new g.w.Event('resize'));
  assert.equal(g.state('state.width'),666);
  assert.equal(g.state('state.height'),197);
  assert.equal(g.state('state.pointer.active'),false,'moving a fixed-size board must cancel a needle aimed at its old client position');
  g.mouse(g.w,'mouseup',oldClientPoint.x,oldClientPoint.y);assertProgress();
  wrap.getBoundingClientRect = nativeRect;
  canvas.getBoundingClientRect = nativeCanvasRect;
  g.w.dispatchEvent(new g.w.Event('resize'));

  const forced = touch(white);
  g.touch('touchstart',[forced],[forced]);
  g.evaluate('resizeCanvas();');
  assert.equal(g.state('state.pointer.active'),false,'explicit hydration/refresh still runs even at identical dimensions');
  g.touch('touchend',[],[forced]);assertProgress();
});

