// Explicit boards for mechanics, reward accounting and visual QA. Random
// planning is exercised separately; this never changes the production planner.
function roundFixtureSource({level=4,recipe={blackhead:6,whitehead:2,cyst:0},region='nose_cheek',
  pace='busy',setup='',keepPlan=false}={}) {
  return `(() => {
    document.querySelectorAll('.modal-backdrop.open').forEach(modal=>modal.classList.remove('open'));
    const originalPlanner=chooseAdventurePlan;
    const fixedPlan=${JSON.stringify({version:1,region,pace,recipe})};
    const matchingClient=CLIENTS.findIndex(client=>client.zoneId===fixedPlan.region);
    if(matchingClient>=0)state.clientIndex=matchingClient;
    chooseAdventurePlan=()=>({...fixedPlan,recipe:{...fixedPlan.recipe}});
    try {
      wardrobeProgress.level=${JSON.stringify(level)};
      state.runLevel=wardrobeProgress.level;
      generateLevel(0);
    } finally {chooseAdventurePlan=originalPlanner;}
    if(!${JSON.stringify(keepPlan)})state.roundPlan=null;
    state.paused=false;selectTool('steam');state.discoveredGifts=[];
    for(const p of state.pimples) {
      p.giftId=null;p.linkedPore=false;p.sharedPore=null;
      p.blackheadCount=1;p.blackheadLengths=[1];p.blackheadSize='normal';p.whiteheadSize='normal';
    }
    ${setup}
    state.initialPimples=state.pimples.map(({cfg,...p})=>JSON.parse(JSON.stringify(p)));
    saveCurrentSession(true);
  })()`;
}

function setupRound(g,options) {
  g.evaluate(roundFixtureSource(options));
  g.frame();
}

module.exports={setupRound,roundFixtureSource};
