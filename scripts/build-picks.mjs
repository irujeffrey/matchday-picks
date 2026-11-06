import { mkdir, writeFile } from 'node:fs/promises';

const footballKey = process.env.APIFOOTBALL_KEY;
const basketballKey = process.env.APIBASKETBALL_KEY;
if (!footballKey || !basketballKey) throw new Error('Set APIFOOTBALL_KEY and APIBASKETBALL_KEY in repository secrets');

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
const basketballBase = 'https://v1.basketball.api-sports.io';

// One fixtures request plus at most 45 prediction requests per day.
const rawFixtures = await api(footballBase, `/fixtures?date=${date}&timezone=Europe%2FLondon`, footballKey);
const scheduled = rawFixtures.filter(f => ['NS', 'TBD'].includes(f.fixture?.status?.short));
const footballPicks = [];
for (const fixture of scheduled.slice(0, 45)) {
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

// Basketball has no predictions endpoint in API-Basketball. Estimate a win
// probability from season standings for up to 20 leagues to conserve quota.
const rawGames = await api(basketballBase, `/games?date=${date}&timezone=Europe%2FLondon`, basketballKey);
const games = rawGames.filter(g => g.status?.short === 'NS' && g.league?.id && g.league?.season);
const leagueCounts = new Map();
for (const g of games) {
  const key = `${g.league.id}|${g.league.season}`;
  leagueCounts.set(key, (leagueCounts.get(key) ?? 0) + 1);
}
const leagueKeys = [...leagueCounts].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([key]) => key);
const standings = new Map();
for (const key of leagueKeys) {
  const [league, season] = key.split('|');
  await sleep(6200);
  const rows = await api(basketballBase, `/standings?league=${league}&season=${encodeURIComponent(season)}`, basketballKey);
  const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object'
    ? (value.team?.id ? [value] : Object.values(value).flatMap(flatten)) : [];
  standings.set(key, flatten(rows));
}
function winRate(row) {
  const value = row?.games?.win?.percentage ?? row?.win?.percentage;
  if (value == null) return null;
  const number = Number.parseFloat(String(value).replace('%', ''));
  return Number.isFinite(number) ? (number > 1 ? number / 100 : number) : null;
}
const basketballPicks = [];
for (const game of games) {
  const rows = standings.get(`${game.league.id}|${game.league.season}`) ?? [];
  const home = rows.find(r => String(r.team?.id) === String(game.teams?.home?.id));
  const away = rows.find(r => String(r.team?.id) === String(game.teams?.away?.id));
  const h = winRate(home), a = winRate(away);
  if (h == null || a == null) continue;
  const pHome = 1 / (1 + Math.exp(-((h - a) * 3.2 + 0.16)));
  const confidence = Math.round(Math.max(pHome, 1 - pHome) * 100);
  if (confidence < 60) continue;
  basketballPicks.push({ sport: 'basketball', date: game.date, league: game.league.name,
    home: game.teams.home.name, away: game.teams.away.name,
    pick: pHome >= 0.5 ? game.teams.home.name : game.teams.away.name, confidence });
}

const picks = {
  football: footballPicks.sort((a, b) => b.confidence - a.confidence),
  basketball: basketballPicks.sort((a, b) => b.confidence - a.confidence)
};
await mkdir('site', { recursive: true });
await writeFile('site/picks.json', JSON.stringify({ updatedAt: new Date().toISOString(), date, picks }, null, 2) + '\n');
console.log(`Built ${picks.football.length} football and ${picks.basketball.length} basketball picks for ${date}`);
