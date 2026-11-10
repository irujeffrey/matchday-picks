import { mkdir, writeFile } from 'node:fs/promises';

const footballKey = process.env.APIFOOTBALL_KEY;
const basketballKey = process.env.API_NINJAS_KEY;

if (!footballKey || !basketballKey) {
  throw new Error('Missing repository secrets: APIFOOTBALL_KEY and API_NINJAS_KEY');
}

// Keep the repository's existing London-based daily slate convention.
const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(new Date());
const part = type => parts.find(item => item.type === type).value;
const date = `${part('year')}-${part('month')}-${part('day')}`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function footballApi(path) {
  const response = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': footballKey }
  });
  const body = await response.json();
  const errors = body.errors && (Array.isArray(body.errors)
    ? body.errors.length
    : Object.keys(body.errors).length);
  if (!response.ok || errors) {
    throw new Error(`API-Football ${path}: ${JSON.stringify(body.errors ?? body).slice(0, 500)}`);
  }
  return body.response ?? [];
}

async function basketballApi(path) {
  const response = await fetch(`https://api.api-ninjas.com/v1${path}`, {
    headers: { 'X-Api-Key': basketballKey }
  });
  const body = await response.json();
  if (!response.ok || !Array.isArray(body)) {
    throw new Error(`API Ninjas ${path}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

function localDay(value) {
  const fields = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const get = type => fields.find(item => item.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function previousDay(value) {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const footballCandidates = [];

// FOOTBALL: API-Football 1X2 forecast, with a strict top-pick and separation filter.
const fixtures = await footballApi(`/fixtures?date=${date}&timezone=Europe%2FLondon`);
const scheduled = fixtures.filter(fixture =>
  ['NS', 'TBD'].includes(fixture.fixture?.status?.short)
);

for (const fixture of scheduled) {
  // API-Football rate limits vary by plan; space prediction requests.
  await sleep(6200);
  const predictions = await footballApi(`/predictions?fixture=${fixture.fixture.id}`);
  const prediction = predictions[0]?.predictions;
  const percentages = prediction?.percent ?? {};

  const choices = [
    { name: fixture.teams?.home?.name, value: Number.parseFloat(percentages.home) },
    { name: 'Draw', value: Number.parseFloat(percentages.draw) },
    { name: fixture.teams?.away?.name, value: Number.parseFloat(percentages.away) }
  ].filter(choice => choice.name && Number.isFinite(choice.value));

  // Missing one of the three 1X2 probabilities? Do not guess.
  if (choices.length !== 3) continue;

  choices.sort((a, b) => b.value - a.value);
  const [best, second] = choices;
  const lead = best.value - second.value;

  if (best.value < 75 || lead < 12) continue;

  footballCandidates.push({
    sport: 'football',
    date: fixture.fixture.date,
    league: fixture.league?.name ?? 'Football',
    home: fixture.teams.home.name,
    away: fixture.teams.away.name,
    pick: best.name,
    confidence: best.value,
    lead,
    // Heuristic ranking score, not a probability.
    selectionScore: (best.value - 75) + ((lead - 12) * 0.5),
    metricType: 'api_prediction',
    evidence: `API-Football top outcome ${best.value}% with ${lead.toFixed(1)} percentage-point lead`
  });
}

// BASKETBALL: standings-only evidence is explicitly experimental.
// Require a meaningful win-rate gap and adequate games played.
const basketballLeagues = ['nba', 'wnba', 'ncaab', 'ncaaw'];
const rawGames = [];

for (const league of basketballLeagues) {
  for (const gameDate of [previousDay(date), date]) {
    let offset = 0;
    while (true) {
      await sleep(700);
      const page = await basketballApi(
        `/basketballgames?league=${league}&date=${gameDate}&offset=${offset}`
      );
      rawGames.push(...page);
      if (page.length < 50 || offset >= 200) break;
      offset += 50;
    }
  }
}

const uniqueGames = [...new Map(rawGames
  .filter(game =>
    game.status === 'scheduled' &&
    game.start_time &&
    new Date(game.start_time) > new Date() &&
    localDay(game.start_time) === date
  )
  .map(game => [game.game_id, game])
).values()];

const leaguesInSlate = [...new Set(uniqueGames.map(game => game.league))];
const standingsByLeague = new Map();
const basketballUnavailable = [];

for (const league of leaguesInSlate) {
  await sleep(700);
  try {
    standingsByLeague.set(
      league,
      await basketballApi(`/basketballstandings?league=${league}`)
    );
  } catch (error) {
    basketballUnavailable.push({ league, reason: error.message });
    console.warn(`Skipping ${league}: ${error.message}`);
  }
}

const winRate = row => {
  const value = Number(row?.win_pct);
  return Number.isFinite(value) ? value : null;
};
const basketballCandidates = [];

for (const game of uniqueGames) {
  const rows = standingsByLeague.get(game.league) ?? [];
  const home = rows.find(row =>
    String(row.team?.team_id) === String(game.home_team?.team_id)
  );
  const away = rows.find(row =>
    String(row.team?.team_id) === String(game.away_team?.team_id)
  );
  const homeRate = winRate(home);
  const awayRate = winRate(away);
  if (homeRate === null || awayRate === null) continue;

  const homeGames = Number(home?.games_played ?? 0);
  const awayGames = Number(away?.games_played ?? 0);
  const sample = Math.min(homeGames, awayGames);
  const gap = Math.abs(homeRate - awayRate);

  if (sample < 10 || gap < 0.20) continue;

  // This is a heuristic estimate, not a trained/calibrated probability.
  const sampleWeight = Math.sqrt(sample / (sample + 8));
  const pHome = 1 / (1 + Math.exp(-((homeRate - awayRate) * sampleWeight * 3.2 + 0.16)));
  const estimate = Math.round(Math.max(pHome, 1 - pHome) * 100);
  if (estimate < 70) continue;

  basketballCandidates.push({
    sport: 'basketball',
    date: game.start_time,
    league: String(game.league).toUpperCase(),
    home: game.home_team.name,
    away: game.away_team.name,
    pick: pHome >= 0.5 ? game.home_team.name : game.away_team.name,
    confidence: estimate,
    standingsGap: Number(gap.toFixed(3)),
    sampleGames: sample,
    // Separate sport-specific evidence score; not cross-sport probability.
    selectionScore: ((gap - 0.20) * 100) + ((sample - 10) * 0.15) + (estimate - 70) * 0.2,
    metricType: 'experimental_model_estimate',
    evidence: `Standings win-rate gap ${(gap * 100).toFixed(1)} points; at least ${sample} games per team`
  });
}

// Shortlist the best candidates from both sports. Do not force a quota per sport.
// Because the underlying evidence types differ, selectionScore is only a
// practical heuristic for ordering candidates, not a comparable probability.
const sortByStrength = (a, b) =>
  (b.selectionScore ?? 0) - (a.selectionScore ?? 0) ||
  (new Date(a.date) - new Date(b.date));

const recommended = [...footballCandidates, ...basketballCandidates]
  .sort(sortByStrength)
  .slice(0, 5)
  .sort((a, b) => new Date(a.date) - new Date(b.date));

const recommendedSet = new Set(recommended);
const picks = {
  football: footballCandidates.filter(pick => recommendedSet.has(pick))
    .sort((a, b) => new Date(a.date) - new Date(b.date)),
  basketball: basketballCandidates.filter(pick => recommendedSet.has(pick))
    .sort((a, b) => new Date(a.date) - new Date(b.date)),
  recommended
};

await mkdir('site', { recursive: true });
await writeFile('site/picks.json', JSON.stringify({
  updatedAt: new Date().toISOString(),
  date,
  criteria: {
    footballMinTopOutcome: 75,
    footballMinLead: 12,
    basketballMinGamesPerTeam: 10,
    basketballMinStandingsGap: 0.20,
    basketballMinExperimentalEstimate: 70,
    maxCombinedRecommendations: 5
  },
  picks,
  basketballUnavailable
}, null, 2) + '\n');

console.log(
  `Built ${picks.recommended.length} selective recommendations ` +
  `(${picks.football.length} football, ${picks.basketball.length} basketball) for ${date}.`
);
