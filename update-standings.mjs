// Fetches the eight league tables and writes standings.json next to index.html.
//
//   node update-standings.mjs
//
// Two sources, tried in order, per league:
//
//   1. ESPN's own JSON (live, updates as results come in, deductions applied)
//   2. football-data.co.uk results CSV, from which we build the table ourselves
//
// ESPN is preferred because it publishes the finished table, but it does not
// always roll the smaller divisions over to the new season on time. So the
// script checks which season ESPN handed back and drops to source 2 if it is
// showing last year's clubs. Neither needs a key.

import { readFile, writeFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('players.json', 'utf8'));
const OUT = 'standings.json';
const SEASON = config.season;

// 2026 -> "2627", the folder football-data.co.uk uses for the 2026/27 season
const yy = SEASON % 100;
const SEASON_CODE = `${String(yy).padStart(2, '0')}${String((yy + 1) % 100).padStart(2, '0')}`;

let previous = null;
try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }

/* ---------- source 1: ESPN ---------- */
const stat = (entry, name) => entry.stats.find(s => s.name === name)?.value ?? 0;

async function fromEspn(league) {
  // note /apis/v2/ — /apis/site/v2/ returns an empty object for standings
  const url = `https://site.api.espn.com/apis/v2/sports/soccer/${league.espn}/standings?season=${SEASON}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.json();
  const standings = body.children?.[0]?.standings;
  if (!standings?.entries?.length) throw new Error('no standings in the response');

  const year = standings.season ?? body.children[0].season?.year;
  if (year !== SEASON) throw new Error(`ESPN is still on the ${year}/${(year + 1) % 100} season`);

  const teams = standings.entries
    .map(e => ({
      rank: stat(e, 'rank'),
      name: e.team.displayName,
      played: stat(e, 'gamesPlayed'),
      points: stat(e, 'points')
    }))
    .sort((a, b) => a.rank - b.rank);

  // ESPN publishes no "as at" timestamp on standings, so the only honest
  // freshness signal is when we asked and how many games have been played.
  return { teams, lastModified: null, latestMatch: null };
}

/* ---------- independent check: when did this division last actually play? ----------
   Asked of ESPN's scoreboard, which is date-driven rather than season-driven, so
   it answers even for divisions whose standings are stuck on last season. This is
   what lets the page say "the table is missing Saturday" rather than leaving you
   to guess. Never fatal: if it fails we just don't show the cross-check. */
const yyyymmdd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

async function lastFixturePlayed(league) {
  const to = new Date();
  const from = new Date(Date.now() - 28 * 864e5);
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espn}/scoreboard`
            + `?dates=${yyyymmdd(from)}-${yyyymmdd(to)}&limit=400`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const events = (await res.json()).events || [];
    const done = events
      .filter(e => e.status?.type?.completed)
      .map(e => e.date?.slice(0, 10))
      .filter(Boolean)
      .sort();
    return done.pop() || null;
  } catch { return null; }
}

/* ---------- source 2: results CSV, table built here ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map(h => h.trim());
  return rows.filter(r => r.length > 3 && r.some(v => v !== ''))
             .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

async function fromResults(league) {
  const url = `https://www.football-data.co.uk/mmz4281/${SEASON_CODE}/${league.div}.csv`;

  // GitHub's runners share IP addresses, and this site rate-limits them, so a
  // single 429 shouldn't cost us a whole week's results. Three tries, backing
  // off, with a browser-shaped User-Agent because the default one gets refused.
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                    + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'text/csv,*/*'
      }
    });
    if (res.ok) break;
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 4000));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} after 3 tries`);
  const lastModified = res.headers.get('last-modified') || null;

  let latestMatch = null;
  const teams = new Map();
  const get = n => {
    if (!teams.has(n)) teams.set(n, { name: n, played: 0, gf: 0, ga: 0, points: 0 });
    return teams.get(n);
  };

  for (const m of parseCsv(await res.text())) {
    const hg = Number(m.FTHG), ag = Number(m.FTAG);
    if (!m.HomeTeam || !m.AwayTeam || m.FTHG === '' || !Number.isFinite(hg) || !Number.isFinite(ag)) continue;

    // dates come as dd/mm/yyyy or dd/mm/yy
    const [d, mo, y] = (m.Date || '').split('/');
    if (d && mo && y) {
      const iso = `${y.length === 2 ? '20' + y : y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
      if (!latestMatch || iso > latestMatch) latestMatch = iso;
    }
    const h = get(m.HomeTeam), a = get(m.AwayTeam);
    h.played++; a.played++;
    h.gf += hg; h.ga += ag; a.gf += ag; a.ga += hg;
    if (hg > ag) h.points += 3; else if (ag > hg) a.points += 3; else { h.points++; a.points++; }
  }

  for (const [team, docked] of Object.entries(config.deductions?.[league.key] || {})) {
    if (teams.has(team)) teams.get(team).points -= docked;
  }
  if (!teams.size) throw new Error('no matches played yet');

  // points, then goal difference, then goals scored, then alphabetically
  return { teams: rank([...teams.values()]), lastModified, latestMatch };
}

const fingerprint = teams => teams.map(t => `${t.rank}:${t.name}:${t.points}`).join('|');

/* ---------- shared: sort a set of teams into a league table ---------- */
// points, then goal difference, then goals scored, then alphabetically
function rank(teams){
  return teams
    .map(t => ({ ...t, gd: t.gf - t.ga }))
    .sort((x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf || x.name.localeCompare(y.name))
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

/* ---------- source 3: the SPFL's own results, as a top-up ----------
   football-data.co.uk only refreshes the Scottish lower divisions midweek, so
   a Saturday result can be four days late. The SPFL publishes its own results
   as plain HTML within the hour. This reads those, and adds any that are newer
   than the newest result already in the table.

   It's a top-up, not a source in its own right: the sidebar only carries recent
   fixtures, so it can't build a season's table from scratch. If it fails, or
   the markup changes, you simply keep the table you already had. */

const MONTHS = ['january','february','march','april','may','june',
                'july','august','september','october','november','december'];

function parseSpflDate(text){
  // "Saturday 22nd August 2026" -> "2026-08-22"
  const m = /(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)\s+(\d{4})/.exec(text || '');
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const strip = h => h.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function spflResults(slug){
  const res = await fetch(`https://spfl.co.uk/league/${slug}/table`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'text/html'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const out = [];
  for (const block of html.split('fixtures-list__group"').slice(1)) {
    const date = parseSpflDate((/fixtures-list__group__day">([^<]*)</.exec(block) || [])[1]);
    const teams = [...block.matchAll(/fixtures-list__results__team">([\s\S]*?)<\/span>/g)]
      .map(m => strip(m[1]));
    const score = /fixtures-list__results__score">\s*(\d+)\s*-\s*(\d+)/.exec(block);
    if (!date || teams.length < 2 || !score) continue;
    out.push({ date, home: teams[0], away: teams[1], hg: +score[1], ag: +score[2] });
  }
  if (!out.length) throw new Error('no results found in the page — the markup may have changed');
  return out;
}

// match an SPFL club name onto whatever the results feed calls the same club
function sameClub(a, b, groups){
  const na = normName(a), nb = normName(b);
  if (na === nb || na.startsWith(nb) || nb.startsWith(na)) return true;
  return groups.some(g => g.has(na) && g.has(nb));
}

const normName = s => s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
  .replace(/\bUTD\b/g, 'UNITED').replace(/\b(FC|AFC|THE)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

// the alias lists double as "these names mean the same club"
const aliasGroups = Object.values(config.aliases)
  .map(v => new Set([].concat(v).map(normName)))
  .filter(g => g.size > 1);

function topUp(table, results, after){
  const fresh = results.filter(r => !after || r.date > after);
  if (!fresh.length) return { table, added: 0, newest: after };

  const find = name => table.find(t => sameClub(t.name, name, aliasGroups));
  let added = 0, newest = after;

  for (const r of fresh){
    const h = find(r.home), a = find(r.away);
    if (!h || !a) continue;                     // unknown club: leave well alone
    h.played++; a.played++;
    h.gf += r.hg; h.ga += r.ag; a.gf += r.ag; a.ga += r.hg;
    if (r.hg > r.ag) h.points += 3;
    else if (r.ag > r.hg) a.points += 3;
    else { h.points++; a.points++; }
    added++;
    if (!newest || r.date > newest) newest = r.date;
  }
  return { table: rank(table), added, newest };
}

/* ---------- go ---------- */
const leagues = {};
const failed = [];

for (const league of config.leagues) {
  const label = league.key.padEnd(18);
  const notes = [];
  let result = null, source = null;

  for (const [name, fn] of [['espn', fromEspn], ['football-data.co.uk', fromResults]]) {
    try { result = await fn(league); source = name; break; }
    catch (err) { notes.push(`${name}: ${err.message}`); }
  }

  if (result) {
    // where the feed lags, add anything newer straight from the SPFL
    if (league.spfl && source !== 'espn') {
      try {
        const merged = topUp(result.teams, await spflResults(league.spfl), result.latestMatch);
        if (merged.added) {
          result.teams = merged.table;
          result.latestMatch = merged.newest;
          notes.push(`spfl: added ${merged.added} newer result${merged.added > 1 ? 's' : ''}`);
        }
      } catch (err) { notes.push(`spfl: ${err.message}`); }
    }
    const table = result.teams;
    const before = previous?.leagues?.[league.key];
    const moved = !before || fingerprint(before.teams) !== fingerprint(table);

    leagues[league.key] = {
      name: `${league.country} ${league.name}`,
      source,
      checked: new Date().toISOString(),                        // when this run asked
      // only claim a move once we've actually watched one happen
      changed: moved && before ? new Date().toISOString() : (before?.changed ?? null),
      watchingSince: before?.watchingSince ?? new Date().toISOString(),
      lastModified: result.lastModified,                        // when the source file changed
      latestMatch: result.latestMatch,                          // newest result in our table
      lastFixture: await lastFixturePlayed(league),             // newest result in real life
      teams: table
    };
    const L = leagues[league.key];
    const behind = L.latestMatch && L.lastFixture && L.lastFixture > L.latestMatch;
    const when = L.latestMatch ? `, latest result ${L.latestMatch}` : '';
    const lag = behind ? `  ** table is missing fixtures from ${L.lastFixture} **` : '';
    if (!moved && before) notes.push('table unchanged since last run');
    const spflNote = notes.find(n => n.startsWith('spfl: added'));
    const via = source === 'espn' ? '' : `  (via ${source}${spflNote ? ' + SPFL' : ''} — ${notes[0]})`;
    console.log(`ok   ${label} ${table.length} teams${when}, top: ${table[0].name}${via}${lag}`);
  } else if (previous?.leagues?.[league.key]) {
    leagues[league.key] = previous.leagues[league.key];
    failed.push(`${league.key}: ${notes.join(' | ')}`);
    console.warn(`old  ${label} kept last run's table — ${notes.join(' | ')}`);
  } else {
    failed.push(`${league.key}: ${notes.join(' | ')}`);
    console.error(`FAIL ${label} ${notes.join(' | ')}`);
  }
  await new Promise(r => setTimeout(r, 300));
}

await writeFile(OUT, JSON.stringify({
  updated: new Date().toISOString(),
  source: Object.values(leagues).every(l => l.source === 'espn') ? 'espn' : 'mixed',
  season: SEASON,
  failed,
  leagues
}, null, 1));
console.log(`\nwrote ${OUT}${failed.length ? ` with ${failed.length} problem(s)` : ''}`);

/* ---------- check every pick resolves ---------- */
const norm = s => s.toUpperCase()
  .replace(/[^A-Z0-9 ]/g, ' ')
  .replace(/\bUTD\b/g, 'UNITED')
  .replace(/\b(FC|AFC|THE)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

const variants = picked => [].concat(config.aliases[picked] ?? picked).map(norm);

function sharedStart(a, b) {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i] !== b[i]) break; n++; }
  return n;
}

const problems = new Map();
for (const league of config.leagues) {
  const table = leagues[league.key]?.teams || [];
  for (const picked of new Set(config.players.map(p => p.picks[league.key]))) {
    const want = variants(picked);
    if (table.some(t => want.includes(norm(t.name)))) continue;

    const near = table
      .map(t => ({ name: t.name, score: Math.max(...want.map(w => sharedStart(norm(t.name), w))) }))
      .filter(s => s.score > 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => `"${s.name}"`);
    problems.set(`${league.key} / ${picked}`,
      near.length ? `did you mean ${near.join(' or ')}?`
                  : 'no club with a similar name is in that division — check the source is on the right season');
  }
}

if (problems.size) {
  console.warn('\nThese picks did not match a club:');
  for (const [pick, note] of problems) console.warn(`  ${pick.padEnd(36)} ${note}`);
} else {
  console.log('every pick matched a club');
}
