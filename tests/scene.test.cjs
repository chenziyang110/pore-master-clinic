const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createGame } = require('./harness.cjs');

const sizes = [[296, 230], [666, 197]];
const read = (game, code) => JSON.parse(JSON.stringify(game.evaluate(code)));
const digest = (game, name) => createHash('sha256').update(game.pixels.get(game.evaluate(name)).canvas.toBuffer('image/png')).digest('hex');
function assertLayout(game, context) {
  const scene = read(game, '({ width: state.width, height: state.height, pimples: state.pimples, scale: state.sceneLayout.scale })');
  for (const p of scene.pimples) {
    assert.ok(p.x - p.radius >= 0 && p.x + p.radius <= scene.width, `${context}: horizontal bounds for ${p.id}`);
    assert.ok(p.y - p.radius >= 0 && p.y + p.radius <= scene.height, `${context}: vertical bounds for ${p.id}`);
    assert.equal(p.hitRadius, p.baseRadius, `${context}: original hit area`);
    for (const other of scene.pimples) {
      if (other.id <= p.id) continue;
      assert.ok(Math.hypot(p.x - other.x, p.y - other.y) >= p.radius + other.radius, `${context}: overlap ${p.id}/${other.id}`);
    }
  }
  assert.deepEqual(game.runtimeErrors, [], context);
  return scene;
}

test('actual mobile and landscape sizes: 20 seeds, all client recipes and custom densities fit', async () => {
  for (const [width, height] of sizes) {
    const game = await createGame({legacyRecipe:true, width, height, seed: 1 });
    try {
      for (let seed = 1; seed <= 20; seed++) {
        for (const [client, density] of [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 8], [0, 11]]) {
          game.evaluate(`(() => { let seed = ${seed}; Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296); state.clientIndex = ${client}; generateLevel(${density}); })()`);
          assertLayout(game, `${width}x${height} seed ${seed}, client ${client}, density ${density}`);
          assert.equal(game.evaluate('state.initialPimples.length'), game.evaluate('state.pimples.length'));
        }
      }
    } finally { game.close(); }
  }
});

test('20 seeds resize in both directions without collisions, state loss or cumulative radius drift', async () => {
  for (const [width, height] of sizes) {
    for (let seed = 1; seed <= 20; seed++) {
      const game = await createGame({legacyRecipe:true, width, height, seed });
      try {
        game.evaluate('state.pimples[0].steamed = 0.91; state.pimples[0].pressure = 0.32; state.pimples[1].iced = true;');
        const original = read(game, 'state.pimples.map(p => ({id:p.id,x:p.x,y:p.y,radius:p.radius}))');
        const next = sizes.find(size => size[0] !== width);
        game.resize(...next, 2);
        assertLayout(game, `${width}x${height} -> ${next.join('x')} seed ${seed}`);
        assert.equal(game.evaluate('state.pimples[0].steamed'), 0.91);
        assert.equal(game.evaluate('state.pimples[0].pressure'), 0.32);
        assert.equal(game.evaluate('state.pimples[1].iced'), true);
        game.resize(width, height, 1);
        const restored = assertLayout(game, `round trip seed ${seed}`);
        for (const p of restored.pimples) {
          const before = original.find(item => item.id === p.id);
          for (const key of ['x', 'y', 'radius']) assert.ok(Math.abs(p[key] - before[key]) < 1e-9, `${key} drift`);
        }
      } finally { game.close(); }
    }
  }
});

test('resize carries attached residue geometry, gel, bruises, lens drops and flying trophy destinations', async () => {
  const game = await createGame({legacyRecipe:true, width: 666, height: 197, seed: 8 });
  try {
    game.evaluate(`(() => {
      state.clientIndex = 2; generateLevel();
      const p = state.pimples.find(p => p.type === 'cyst');
      const point = {x:p.x+2,y:p.y+3};
      state.surfaceResidues = [{...point,kind:'worm',pimpleId:p.id,r:8,thickness:2,wormLen:18,alpha:1,pts:[{...point,distFromRoot:0,distFromTip:18,hasDarkCap:false},{x:p.x+4,y:p.y+5,distFromRoot:9,distFromTip:9,hasDarkCap:false},{x:p.x+6,y:p.y+7,distFromRoot:18,distFromTip:0,hasDarkCap:false}]}];
      state.iceGelBlobs = [{...point,r:10,bx:2,by:-2}];
      state.bruises = [{...point,r:6,alpha:0.2}];
      state.lensSplatters = [{...point,r:5,alpha:0.8,color:'#eeddbb',subDrops:[{dx:2,dy:3,rr:1}]}];
      state.flyingTrophies = [{sx:p.x,sy:p.y,tx:state.width-51,ty:68,kind:'seed',duration:0.44,progress:0.2,rot:0}];
    })()`);
    const before = read(game, '({p:state.pimples.find(p=>p.type==="cyst"),layout:state.sceneLayout})');
    game.resize(296, 230);
    const after = read(game, '({p:state.pimples.find(p=>p.type==="cyst"),residue:state.surfaceResidues[0],gel:state.iceGelBlobs[0],bruise:state.bruises[0],splat:state.lensSplatters[0],trophy:state.flyingTrophies[0],layout:state.sceneLayout})');
    const ratio = after.p.radius / before.p.radius;
    for (const item of [after.residue, after.gel, after.bruise, after.splat]) {
      assert.ok(Math.abs(item.x - (after.p.x + 2 * ratio)) < 1e-9);
      assert.ok(Math.abs(item.y - (after.p.y + 3 * ratio)) < 1e-9);
    }
    assert.ok(Math.abs(after.residue.r - 8 * ratio) < 1e-9);
    assert.ok(Math.abs(after.residue.pts[1].distFromRoot - 9 * ratio) < 1e-9);
    assert.equal(after.residue.pts[2].hasDarkCap, false);
    assert.ok(Math.abs(after.splat.subDrops[0].dx - 2 * ratio) < 1e-9);
    assert.ok(Math.abs(after.gel.bx - 2 * ratio) < 1e-9);
    assert.ok(Math.abs(after.trophy.tx - (296 - 54 + 3 * ratio)) < 1e-9);
    assertLayout(game, 'effect migration');
  } finally { game.close(); }
});

test('before/after re-render identical untreated skin after style/rotation and preserve original state on restore', async () => {
  const game = await createGame({legacyRecipe:true, width: 296, height: 230, seed: 5 });
  try {
    game.frame();
    game.evaluate('captureFaceSnapshot(afterSnap)');
    assert.equal(digest(game, 'beforeSnap'), digest(game, 'afterSnap'), 'same untreated model');
    const realistic = digest(game, 'beforeSnap');
    game.evaluate("state.styleMode = 'creamy'; renderSkinTexture(); renderScene(); captureFaceSnapshot(afterSnap);");
    assert.equal(digest(game, 'beforeSnap'), digest(game, 'afterSnap'), 'same style on both sides');
    assert.notEqual(digest(game, 'beforeSnap'), realistic, 'style change is reflected');
    const creamy = digest(game, 'beforeSnap');
    game.resize(666, 197);
    game.evaluate('captureFaceSnapshot(afterSnap)');
    assert.equal(digest(game, 'beforeSnap'), digest(game, 'afterSnap'), 'same rotated geometry');
    game.resize(296, 230);
    assert.equal(digest(game, 'beforeSnap'), creamy, 'deterministic composition after round trip');
    game.evaluate('state.pimples.forEach(p => {p.state = P_STATE.HEALED; p.iced = true;}); state.beforeCaptured = false; resizeCanvas(); captureFaceSnapshot(afterSnap);');
    assert.equal(digest(game, 'beforeSnap'), creamy, 'restored half-session does not replace baseline');
    assert.notEqual(digest(game, 'beforeSnap'), digest(game, 'afterSnap'), 'actual treatment is visible');
    assert.deepEqual(game.runtimeErrors, []);
  } finally { game.close(); }
});

test('clean comparisons omit active guidance and leave the live canvas unchanged', async () => {
  const game = await createGame({legacyRecipe:true, width: 296, height: 230, seed: 3 });
  try {
    game.frame();
    const before = digest(game, 'beforeSnap');
    game.evaluate("state.currentTool = 'needle'; renderScene();");
    const live = digest(game, 'canvas');
    game.evaluate('captureFaceSnapshot(beforeSnap); captureFaceSnapshot(afterSnap);');
    assert.equal(digest(game, 'beforeSnap'), before);
    assert.equal(digest(game, 'afterSnap'), before);
    assert.equal(digest(game, 'canvas'), live, 'snapshot transaction restores the canvas');
  } finally { game.close(); }
});

test('departed lens drops clear the cleaning badge without awarding collection points', async () => {
  const game = await createGame({legacyRecipe:true, width: 296, height: 230, seed: 2 });
  try {
    game.evaluate("state.lensSplatters = [{x:100,y:245,r:5,alpha:0.8,color:'#eeddbb',subDrops:[]}]; updateHUD();");
    const score = game.evaluate('state.score');
    assert.equal(game.d.getElementById('badge-swab').textContent, '1');
    game.evaluate('updateSimulation(0.05)');
    assert.equal(game.evaluate('state.lensSplatters.length'), 0);
    assert.equal(game.d.getElementById('badge-swab').classList.contains('show'), false);
    assert.equal(game.evaluate('state.score'), score);
    game.evaluate("state.lensSplatters = [{x:100,y:245,r:5,alpha:0.8,color:'#eeddbb',subDrops:[{dx:0,dy:-17,rr:3}]}]; updateSimulation(0.05);");
    assert.equal(game.evaluate('state.lensSplatters.length'), 1, 'visible subdrop keeps the effect alive');
    game.evaluate('state.lensSplatters[0].y = 260;');
    game.resize(666, 197);
    assert.equal(game.evaluate('state.lensSplatters.length'), 0, 'resize does not resurrect departed drops');
  } finally { game.close(); }
});

