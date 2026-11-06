import { mkdir, writeFile } from 'node:fs/promises';

const footballKey = process.env.APIFOOTBALL_KEY;
const basketballKey = process.env.API_NINJAS_KEY;
if (!footballKey || !basketballKey) throw new Error('Set APIFOOTBALL_KEY and API_NINJAS_KEY in repository secrets');

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(new Date());
const datePart = type => parts.find(part => part.type === type).value;
const date = `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(base, path, key) {
  const res = await fetch(`${base}${path}`, { headers: { 'x-apisports-key': key } });
  const json = await res.json();
  const hasErrors = json.errors && (Array.isArray(json.errors) ? json.errors.length : Object.keys(json.errors).length);
  if (!res.ok || hasErrors) throw new Error(`${path}: ${JSON.stringify(json.errors ?? json).slice(0, 500)}`);
  return json.response ?? [];
}

const footballBase = 'https://v3.football.api-sports.io';
const basketballBase = 'https://api.api-ninjas.com/v1';
async function basketballApi(path) {
  const res = await fetch(`${basketballBase}${path}`, { headers: { 'X-Api-Key': basketballKey } });
  const body = await res.json();
  if (!res.ok || !Array.isArray(body)) throw new Error(`API Ninjas ${path}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}
const londonDay = value => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = type => p.find(x => x.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};
const previousDay = value => {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// One fixtures request plus at most 20 prediction requests per day.
const rawFixtures = await api(footballBase, `/fixtures?date=${date}&timezone=Europe%2FLondon`, footballKey);
const scheduled = rawFixtures.filter(f => ['NS', 'TBD'].includes(f.fixture?.status?.short));
const footballPicks = [];
for (const fixture of scheduled.slice(0, 20)) {
  await sleep(6200);
  const predictions = await api(footballBase, `/predictions?fixture=${fixture.fixture.id}`, footballKey);
  const item = predictions[0];
  const percent = item?.predictions?.percent ?? {};
  const choices = [
    { name: fixture.teams.home.name, value: Number.parseFloat(percent.home) },
    { name: 'Draw', value: Number.parseFloat(percent.draw) },
    { name: fixture.teams.away.name, value: Number.parseFloat(percent.away) }
  ].filter(x => Number.isFinite(x.value));
  if (!choices.length) continue;
  const top = choices.sort((a, b) => b.value - a.value)[0];
  if (top.value < 60) continue;
  footballPicks.push({ sport: 'football', date: fixture.fixture.date, league: fixture.league.name,
    home: fixture.teams.home.name, away: fixture.teams.away.name, pick: top.name, confidence: top.value });
}

// API Ninjas free tier includes current-season schedules and standings.
// Its game date is the league's home date, so fetch today and yesterday, then
// keep only scheduled games whose UTC start falls on today's London date.
const basketballLeagues = ['nba', 'wnba', 'ncaab', 'ncaaw'];
const rawGames = [];
for (const league of basketballLeagues) {
  for (const gameDate of [previousDay(date), date]) {
    let offset = 0;
    while (true) {
      await sleep(700);
      const page = await basketballApi(`/basketballgames?league=${league}&date=${gameDate}&offset=${offset}`);
      rawGames.push(...page);
      if (page.length < 50 || offset >= 200) break;
      offset += 50;
    }
  }
}
const games = [...new Map(rawGames.filter(g => g.status === 'scheduled' && g.start_time && new Date(g.start_time) > new Date() && londonDay(g.start_time) === date)
  .map(g => [g.game_id, g])).values()];
const leagueKeys = [...new Set(games.map(g => g.league))];
const standings = new Map();
const basketballUnavailable = [];
for (const league of leagueKeys) {
  await sleep(700);
  let rows;
  try {
    rows = await basketballApi(`/basketballstandings?league=${league}`);
  } catch (error) {
    basketballUnavailable.push({ league, reason: error.message });
    console.warn(`Skipping basketball picks for ${league}: ${error.message}`);
    continue;
  }
  standings.set(league, rows);
}
const winRate = row => Number.isFinite(Number(row?.win_pct)) ? Number(row.win_pct) : null;
const basketballPicks = [];
for (const game of games) {
  const rows = standings.get(game.league) ?? [];
  const home = rows.find(r => String(r.team?.team_id) === String(game.home_team?.team_id));
  const away = rows.find(r => String(r.team?.team_id) === String(game.away_team?.team_id));
  const h = winRate(home), a = winRate(away);
  if (h == null || a == null) continue;
  const sample = Math.min(home.games_played ?? 0, away.games_played ?? 0);
  const sampleWeight = sample > 0 ? Math.sqrt(sample / (sample + 8)) : 0.5;
  const pHome = 1 / (1 + Math.exp(-((h - a) * sampleWeight * 3.2 + 0.16)));
  const confidence = Math.round(Math.max(pHome, 1 - pHome) * 100);
  if (confidence < 60) continue;
  basketballPicks.push({ sport: 'basketball', date: game.start_time, league: game.league.toUpperCase(),
    home: game.home_team.name, away: game.away_team.name,
    pick: pHome >= 0.5 ? game.home_team.name : game.away_team.name, confidence });
}

const picks = {
  football: footballPicks.sort((a, b) => b.confidence - a.confidence),
  basketball: basketballPicks.sort((a, b) => b.confidence - a.confidence)
};
await mkdir('site', { recursive: true });
await writeFile('site/picks.json', JSON.stringify({ updatedAt: new Date().toISOString(), date, picks, basketballUnavailable }, null, 2) + '\n');
console.log(`Built ${picks.football.length} football and ${picks.basketball.length} basketball picks for ${date}; ${basketballUnavailable.length} basketball leagues were unavailable`);
