const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const { createGame } = require('./harness.cjs');

async function appearanceGame(t) {
  const game = await createGame({ seed: 29 });
  t.after(() => { assert.deepEqual(game.runtimeErrors, []); game.close(); });
  return game;
}

const pixel = (ctx, x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
const plain = value => JSON.parse(JSON.stringify(value));

test('blackheads never bleed, while gentle whitehead and deep care leave no blood', async t => {
  const game = await appearanceGame(t);
  for (const clean of [false, true]) {
    for (const trauma of [0, .4, 1]) {
      const blood = game.evaluate(`(() => {
        const p = {...state.pimples[0], type:'blackhead', traumaLevel:${trauma}, bloodDropSize:6.8};
        enterOozingStage(p, ${clean}); return p.bloodDropSize;
      })()`);
      assert.equal(blood, 0, `blackhead trauma ${trauma}, clean ${clean}`);
    }
  }
  for (const type of ['whitehead', 'cyst']) {
    const amounts = plain(game.evaluate(`(() => {
      const p = {...state.pimples[0], type:${JSON.stringify(type)}, traumaLevel:0};
      enterOozingStage(p); const gentle = p.bloodDropSize;
      p.traumaLevel = 1; enterOozingStage(p);
      return {gentle, injured:p.bloodDropSize};
    })()`));
    assert.equal(amounts.gentle, 0, `${type}: no routine blood after gentle care`);
    assert.ok(amounts.injured > 0 && amounts.injured <= 1.6, `${type}: injury produces only a small drop`);
  }
});

test('empty single and connected blackhead pores stay pale even with old saved blood values', async t => {
  const game = await appearanceGame(t);
  for (const creamy of [false, true]) for (const linked of [false, true]) {
    const result = plain(game.evaluate(`(() => {
      const p = {...state.pimples[0], type:'blackhead', linkedPore:${linked}, radius:18,
        headOffsetX:0, headOffsetY:0, bloodDropSize:8, serousDropSize:0,
        state:P_STATE.OOZING, wipeProgress:0, shape:{...state.pimples[0].shape, rot:0}};
      ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.fillStyle='#eec6ad';
      ctx.fillRect(0,0,160,160); ctx.translate(80,80); ctx.scale(3,3);
      renderEmptiedPoreState(p, ${creamy}, 1); ctx.restore();
      return getPimpleMouthOffsets(p).map(mouth => {
        const data = ctx.getImageData(Math.round(80 + mouth.x * 3), Math.round(80 + mouth.y * 3), 1, 1).data;
        return [...data];
      });
    })()`));
    assert.equal(result.length, linked ? 2 : 1);
    for (const [red, green, blue] of result) {
      assert.ok(red > 200 && green > 145 && blue > 125,
        `natural pale pocket, creamy=${creamy}, linked=${linked}: ${red},${green},${blue}`);
    }
  }
});

test('a long extracted filament has an uninterrupted ivory body and one dark terminal cap', async t => {
  const game = await appearanceGame(t);
  const render = game.evaluate('renderRealisticSebumFilament');
  for (const creamy of [false, true]) for (const capped of [false, true]) {
    const canvas = createCanvas(128, 320), context = canvas.getContext('2d');
    context.scale(3, 3);
    const length = 78;
    const points = Array.from({ length: 50 }, (_, index) => ({
      x: 20, y: 94 - index / 49 * length,
      distFromRoot: index / 49 * length, distFromTip: length - index / 49 * length,
      hasDarkCap: capped
    }));
    render(context, points, 3, creamy, 0);
    let previous;
    for (let y = 23; y <= 87; y++) {
      const rgb = pixel(context, 60, y * 3);
      assert.ok(rgb[0] > 225 && rgb[1] > 210 && rgb[2] > 170,
        `body remains ivory at y=${y}: ${rgb}`);
      if (previous) assert.ok(rgb.slice(0, 3).every((channel, index) => Math.abs(channel - previous[index]) <= 3),
        `no transverse colour bands at y=${y}`);
      previous = rgb;
    }
    const tip = pixel(context, 60, 48);
    assert.equal(tip[0] < 120 && tip[1] < 110 && tip[2] < 100, capped,
      'darkness is confined to the terminal cap and disappears when snapped off');
  }
});

test('connected openings share stable geometry and the extracted strand starts at the first mouth', async t => {
  const game = await appearanceGame(t);
  const geometry = plain(game.evaluate(`(() => {
    const p = {...state.pimples[0], type:'blackhead', linkedPore:true, radius:20,
      x:100,y:140,tentOffsetX:3,tentOffsetY:-4,headOffsetX:1,headOffsetY:-2,
      shape:{...state.pimples[0].shape,rot:Math.PI/3}};
    const local = getPimpleMouthOffsets(p), world = getPimpleMouths(p);
    const curve = computeRealisticBlackheadCurve(p, .5, p.x+p.tentOffsetX, p.y+p.tentOffsetY);
    return {local,world,root:curve[0]};
  })()`));
  assert.equal(geometry.local.length, 2);
  assert.ok(Math.abs(Math.hypot(geometry.local[0].x - geometry.local[1].x,
    geometry.local[0].y - geometry.local[1].y) - 20) < 1e-9);
  for (let index = 0; index < 2; index++) {
    assert.ok(Math.abs(geometry.world[index].x - geometry.local[index].x - 103) < 1e-9);
    assert.ok(Math.abs(geometry.world[index].y - geometry.local[index].y - 136) < 1e-9);
  }
  assert.equal(geometry.root.x, geometry.world[0].x);
  assert.equal(geometry.root.y, geometry.world[0].y);
});
