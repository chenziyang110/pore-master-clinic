const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('./harness.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const rng = initial => {
  let seed=initial >>> 0;
  return () => ((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
};

test('seeded regional rounds keep legal varied pores and light rounds improve food and permanent rewards', async t => {
  // One real page supplies the production functions. The batches below create
  // model data only, leaving DOM/physics/save acceptance to their own suites.
  const g=await createGame({seed:83015});
  t.after(() => {assert.deepEqual(g.runtimeErrors,[]);g.close();});
  const recipeFor=g.evaluate('adventureRecipeFor');
  const variantsFor=g.evaluate('adventurePoreVariants');
  const validVariant=g.evaluate('validPoreVariant');
  const validCount=g.evaluate('validBlackheadCount');
  const validShared=g.evaluate('validSharedPore');
  const regions=plain(g.evaluate('TREATMENT_REGIONS.map(region=>region.id)'));
  assert.deepEqual([...regions].sort(),['nose_cheek','nose_tip','chin_jaw','forehead','mouth_ring'].sort());
  const totals={two:0,three:0,four:0,giantSingle:0,giantBundle:0,largeWhite:0,equalBundle:0,unequalBundle:0};
  const shares={};
  for (const region of regions) {
    const draw=rng(7351);
    let black=0,count=0,pureBlack=0,mixed=0;
    for (let sample=0;sample<500;sample++) {
      const recipe=recipeFor(8,region,'busy',draw);
      assert.ok(Object.values(recipe).every(value=>Number.isInteger(value)&&value>=0));
      const size=recipe.blackhead+recipe.whitehead+recipe.cyst;
      assert.ok(size>=8 && size<=12,`${region}: ordinary rounds have a full board`);
      const types=['blackhead','whitehead','cyst'].flatMap(type=>Array(recipe[type]).fill(type));
      const variants=variantsFor(types,8,draw);
      assert.equal(variants.length,types.length,'appearance variants cannot add or remove care targets');
      if (recipe.whitehead===0) {
        pureBlack++;
        assert.equal(variants.some(p=>p.sharedPore),false,'a round without whiteheads cannot hide one in a shared pore');
      } else mixed++;
      let eligible=0,bundles=0;
      for (let index=0;index<types.length;index++) {
        const p={type:types[index],state:0,...variants[index]};
        assert.ok(validVariant(p) && validCount(p) && validShared(p),`${region} sample ${sample}: generated data must restore legally`);
        assert.equal(p.blackheadLengths.length,p.blackheadCount);
        if (p.blackheadCount===1) assert.deepEqual(plain(p.blackheadLengths),[1],
          'single strands retain the length profile accepted by old save validation');
        if (p.type==='blackhead' && !p.linkedPore && !p.sharedPore) eligible++;
        if (p.blackheadCount>1) {
          assert.equal(p.type,'blackhead');assert.equal(p.linkedPore,false);assert.equal(p.sharedPore,null);
          bundles++;
          totals[{2:'two',3:'three',4:'four'}[p.blackheadCount]]++;
          if (p.blackheadLengths.every(value=>value===p.blackheadLengths[0])) totals.equalBundle++;
          else {
            assert.ok(Math.max(...p.blackheadLengths)/Math.min(...p.blackheadLengths)>1.5,
              'unequal bundles have clearly distinguishable long and short strands');
            totals.unequalBundle++;
          }
        }
        if (p.blackheadSize==='giant') totals[p.blackheadCount>1?'giantBundle':'giantSingle']++;
        if (p.whiteheadSize==='large') totals.largeWhite++;
      }
      assert.ok(bundles>=Math.min(2,eligible) && bundles>=eligible*.70,
        'most ordinary blackhead openings offer multiple strands');
      black+=recipe.blackhead;count+=size;
    }
    assert.ok(pureBlack>0 && mixed>0,`${region}: both black-only and mixed recipes occur`);
    shares[region]=black/count;
  }
  for (const region of regions.filter(region=>region!=='chin_jaw')) {
    assert.ok(shares.chin_jaw>shares[region]+.04,'the chin is noticeably more blackhead-heavy than every other region');
  }
  for (const [kind,count] of Object.entries(totals)) assert.ok(count>0,`${kind} is reachable in actual generated variants`);

  const roll=g.evaluate('rollAdventureGifts');
  const food=new Set(plain(g.evaluate('FOOD_ITEMS.map(item=>item.id)')));
  const permanent=new Set(plain(g.evaluate('[...WARDROBE_ITEMS,...DREAM_ITEMS].map(item=>item.id)')));
  const rewardStats={};
  for (const pace of ['busy','light']) {
    const draw=rng(6809),stats={foodRounds:0,permanentRounds:0,items:0};
    for (let sample=0;sample<1000;sample++) {
      const gifts=roll(8,draw,[],{pace});
      const foods=gifts.filter(id=>food.has(id)),keeps=gifts.filter(id=>permanent.has(id));
      assert.equal(foods.length+keeps.length,gifts.length,'every rolled reward belongs to a real catalogue');
      assert.equal(new Set(gifts).size,gifts.length,'distinct gifts can bind to distinct saved care points');
      assert.ok(foods.length<=2 && keeps.length<=1 && gifts.length<=3,
        'even a three-pore light round has room for all rewards, with at most one permanent item');
      stats.foodRounds+=Number(foods.length>0);stats.permanentRounds+=Number(keeps.length>0);stats.items+=gifts.length;
    }
    rewardStats[pace]=stats;
  }
  assert.ok(rewardStats.light.foodRounds>rewardStats.busy.foodRounds+50,'light rounds improve the food chance at the same level');
  assert.ok(rewardStats.light.permanentRounds>rewardStats.busy.permanentRounds+50,'light rounds improve the permanent-gift chance at the same level');
  assert.ok(rewardStats.light.items>rewardStats.busy.items+200,'light rounds provide a materially fuller reward roll');
  t.diagnostic(JSON.stringify({samplesPerRegion:500,blackheadShares:shares,variants:totals,rewards:rewardStats}));
});
