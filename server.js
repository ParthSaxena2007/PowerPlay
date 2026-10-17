// Power Play: energy trading competition server
// Express (REST) + Socket.IO (live push). State lives in memory and is saved to data/db.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const defaults = require('./defaults');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!process.env.ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD not set. Using "admin123". Set it before the event.');

// ---------------------------------------------------------------- persistence
const clone = (o) => JSON.parse(JSON.stringify(o));

function freshGame() {
  return {
    status: 'lobby',        // lobby | running | paused | results | finished
    roundIndex: -1,
    endsAt: 0,
    remainingMs: 0,
    market: {},
    bought: {},             // teamId -> { res: units bought (gross) this round }
    plans: {},              // teamId -> { res: units to generate }
    fired: [],              // flash news shown this round
    firedIdx: [],
    lastResults: null,
  };
}
function freshDb() {
  return { config: clone(defaults.config), resources: clone(defaults.resources), rounds: clone(defaults.rounds), teams: [], game: freshGame() };
}

// Optional free cloud backup (Upstash Redis REST). Survives restarts on free hosting.
const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_KEY = process.env.KV_KEY || 'powerplay-db';
const kvOn = !!(KV_URL && KV_TOKEN);
async function kvGet() {
  const r = await fetch(`${KV_URL}/get/${KV_KEY}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) throw new Error('KV read failed: ' + r.status);
  const { result } = await r.json();
  return result ? JSON.parse(result) : null;
}
let kvBusy = false, kvAgain = false;
async function kvPut() {
  if (!kvOn) return;
  if (kvBusy) { kvAgain = true; return; }
  kvBusy = true;
  try {
    const r = await fetch(`${KV_URL}/set/${KV_KEY}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` }, body: JSON.stringify(db) });
    if (!r.ok) console.error('[kv] save failed', r.status);
  } catch (e) { console.error('[kv] save failed', e.message); }
  kvBusy = false;
  if (kvAgain) { kvAgain = false; kvPut(); }
}

let db = null;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); console.log('[db] loaded', DB_FILE); } catch {}

let saveTimer = null;
function writeNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('[db] save failed', e.message); }
}
let kvTimer = null;
function save() {
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 500);
  if (kvOn && !kvTimer) kvTimer = setTimeout(() => { kvTimer = null; kvPut(); }, 1500);
}

// ---------------------------------------------------------------- helpers
const num = (v, d = 0) => (v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const int = (v) => Math.floor(num(v));
const round2 = (v) => Math.round(v * 100) / 100;
const now = () => Date.now();
const G = () => db.game;
const curRound = () => db.rounds[G().roundIndex] || null;
const resById = (id) => db.resources.find((r) => r.id === id);
const teamById = (id) => db.teams.find((t) => t.id === id);

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(':');
  const test = crypto.scryptSync(String(pw ?? ''), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(test, 'hex'));
}
const token = () => crypto.randomBytes(24).toString('hex');

function supplyFor(round, resId) {
  return Math.round(num(round.supplyPerTeam?.[resId]) * Math.max(1, db.teams.length));
}
function capFor(round, resId) {
  const o = round.caps?.[resId];
  if (o !== undefined && o !== null && o !== '') return int(o);
  return Math.ceil(num(round.supplyPerTeam?.[resId]) * num(round.capMultiplier, 2));
}

function valuationPrice(resId) {
  const res = resById(resId);
  if (!res) return 0;
  if (G().status === 'finished') return num(res.endValue);
  const r = curRound();
  // expiring resources still have resale value while the round is open
  if (!res.storable) return ['running', 'paused'].includes(G().status) && r ? num(r.prices?.[resId]) : 0;
  return r ? num(r.prices?.[resId]) : num(res.endValue);
}
function netWorth(team) {
  let w = team.cash;
  for (const [k, q] of Object.entries(team.inventory || {})) w += q * valuationPrice(k);
  return w;
}
function scoreOf(team) {
  const c = db.config;
  const nw = netWorth(team);
  const tradingPoints = ((nw - num(c.startingCredits)) / Math.max(1, num(c.creditsPerPoint, 1000))) * num(c.cashWeight, 1);
  const powerPoints = team.powerPoints || 0;
  return { netWorth: Math.round(nw), powerPoints: round2(powerPoints), tradingPoints: round2(tradingPoints), total: round2(powerPoints + tradingPoints) };
}
function leaderboard() {
  return db.teams
    .map((t) => ({ id: t.id, name: t.name, blackouts: t.blackouts || 0, ...scoreOf(t) }))
    .sort((a, b) => b.total - a.total || b.powerPoints - a.powerPoints || a.blackouts - b.blackouts)
    .map((row, i) => ({ rank: i + 1, ...row }));
}
function leaderboardVisible() {
  const g = G();
  if (g.status === 'finished') return true;
  if (!db.config.leaderboardVisible) return false;
  const r = curRound();
  return !(r && r.hideLeaderboard && g.status !== 'lobby');
}

// ---------------------------------------------------------------- views
function publicState() {
  const g = G(), c = db.config, r = curRound();
  const prev = db.rounds[g.roundIndex - 1];
  const out = {
    serverNow: now(),
    config: {
      gameName: c.gameName, clubName: c.clubName, startingCredits: c.startingCredits, tariff: c.tariff,
      targetPoints: c.targetPoints, blackoutThreshold: c.blackoutThreshold, greenBonus: c.greenBonus,
      greenThreshold: c.greenThreshold, warningSec: c.warningSec, lockBufferSec: c.lockBufferSec,
      registrationOpen: c.registrationOpen, teamSizeMin: c.teamSizeMin, teamSizeMax: c.teamSizeMax,
    },
    resources: db.resources.map(({ id, name, color, green, storable, weather }) => ({ id, name, color, green, storable, weather })),
    status: g.status,
    roundIndex: g.roundIndex,
    totalRounds: db.rounds.length,
    teamCount: db.teams.length,
    round: null,
    lastResults: g.lastResults ? { roundIndex: g.lastResults.roundIndex, efficiency: g.lastResults.efficiency, title: g.lastResults.title } : null,
    leaderboard: leaderboardVisible()
      ? leaderboard().map(({ rank, name, total, powerPoints, tradingPoints, netWorth }) => ({ rank, name, total, powerPoints, tradingPoints, netWorth }))
      : null,
  };
  if (r && g.status !== 'lobby') {
    out.round = {
      number: g.roundIndex + 1, title: r.title, target: r.target, multiplier: r.multiplier, durationSec: r.durationSec,
      headlines: r.headlines || [], flash: g.fired, prices: r.prices, prevPrices: prev ? prev.prices : null,
      carbonTax: r.carbonTax || {},
      caps: Object.fromEntries(db.resources.map((x) => [x.id, capFor(r, x.id)])),
      market: g.market,
      endsAt: g.endsAt,
      displayEndsAt: g.endsAt - num(c.lockBufferSec) * 1000,
      remainingMs: g.status === 'paused' ? g.remainingMs : null,
      hideLeaderboard: !!r.hideLeaderboard,
    };
  }
  return out;
}
function teamView(team) {
  const g = G();
  return {
    id: team.id, name: team.name, members: team.members, cash: Math.round(team.cash), inventory: team.inventory,
    bought: g.bought[team.id] || {}, plan: g.plans[team.id] || {}, history: team.history || [],
    lastResult: g.lastResults?.teams?.[team.id] || null, ...scoreOf(team),
  };
}
function adminView() {
  return {
    config: db.config, resources: db.resources, rounds: db.rounds, game: db.game,
    teams: db.teams.map((t) => ({
      id: t.id, name: t.name, members: t.members, cash: Math.round(t.cash), inventory: t.inventory,
      blackouts: t.blackouts || 0, history: t.history || [], bought: G().bought[t.id] || {}, plan: G().plans[t.id] || {}, ...scoreOf(t),
    })),
    leaderboard: leaderboard(),
    serverNow: now(),
  };
}

// ---------------------------------------------------------------- broadcasting
let io;
let bcastTimer = null;
function broadcast() {
  if (bcastTimer) return;
  bcastTimer = setTimeout(() => {
    bcastTimer = null;
    io.emit('public', publicState());
    io.to('admin').emit('admin', adminView());
  }, 150);
}
const pushTeam = (team) => io.to('team:' + team.id).emit('team', teamView(team));
const pushAllTeams = () => db.teams.forEach(pushTeam);
function changed(team) { save(); broadcast(); if (team) pushTeam(team); }

// ---------------------------------------------------------------- game engine
function startNextRound() {
  const g = G();
  if (!['lobby', 'results'].includes(g.status)) throw new Error('A round is already in progress.');
  if (g.roundIndex + 1 >= db.rounds.length) throw new Error('No rounds left. Finish the game instead.');
  g.roundIndex += 1;
  const r = curRound();
  g.market = Object.fromEntries(db.resources.map((x) => [x.id, supplyFor(r, x.id)]));
  g.bought = {}; g.plans = {}; g.fired = []; g.firedIdx = [];
  g.endsAt = now() + num(r.durationSec, 720) * 1000;
  g.remainingMs = 0;
  g.status = 'running';
  changed(); pushAllTeams();
}

function settleRound() {
  const g = G(), r = curRound(), c = db.config;
  if (!r) return;
  const eff = Object.fromEntries(db.resources.map((x) => [x.id, num(r.efficiency?.[x.id], 100)]));
  const results = {};
  for (const team of db.teams) {
    const plan = g.plans[team.id] || {};
    const used = {};
    let totalMW = 0, greenMW = 0, tax = 0;
    for (const res of db.resources) {
      const units = Math.max(0, Math.min(int(plan[res.id] || 0), int(team.inventory[res.id] || 0)));
      if (!units) continue;
      const mw = (units * eff[res.id]) / 100;
      used[res.id] = { units, mw: round2(mw) };
      totalMW += mw;
      if (res.green) greenMW += mw;
      tax += units * num(r.carbonTax?.[res.id]);
      team.inventory[res.id] -= units;
    }
    const expired = {};
    for (const res of db.resources) {
      if (!res.storable && team.inventory[res.id]) { expired[res.id] = team.inventory[res.id]; team.inventory[res.id] = 0; }
    }
    const target = Math.max(1, num(r.target, 1));
    const delivered = Math.min(totalMW, target);
    const pct = (totalMW / target) * 100;
    const blackout = pct < num(c.blackoutThreshold, 50);
    const base = blackout ? 0 : (Math.min(pct, 100) / 100) * num(c.targetPoints, 100);
    const greenShare = delivered > 0 ? (Math.min(greenMW, delivered) / delivered) * 100 : 0;
    const bonus = !blackout && greenShare >= num(c.greenThreshold, 35) ? num(c.greenBonus) : 0;
    const mult = num(r.multiplier, 1);
    const points = round2((base + bonus) * mult);
    const revenue = Math.round(delivered * num(c.tariff));
    tax = Math.round(tax);

    team.cash += revenue - tax;
    team.powerPoints = round2((team.powerPoints || 0) + points);
    if (blackout) team.blackouts = (team.blackouts || 0) + 1;

    const entry = {
      round: g.roundIndex + 1, title: r.title, target, totalMW: round2(totalMW), delivered: round2(delivered), pct: round2(pct),
      blackout, greenShare: round2(greenShare), basePoints: round2(base), greenBonus: bonus, multiplier: mult, points,
      revenue, tax, used, expired, cashAfter: Math.round(team.cash),
    };
    team.history = [...(team.history || []).filter((h) => h.round !== entry.round), entry];
    results[team.id] = entry;
  }
  g.lastResults = { roundIndex: g.roundIndex, title: r.title, efficiency: eff, teams: results };
  g.status = 'results';
  g.endsAt = 0;
  changed(); pushAllTeams();
}

function finishGame() {
  if (['running', 'paused'].includes(G().status)) settleRound();
  G().status = 'finished';
  changed(); pushAllTeams();
}

function resetGame() {
  db.game = freshGame();
  for (const t of db.teams) Object.assign(t, { cash: num(db.config.startingCredits), inventory: {}, history: [], powerPoints: 0, blackouts: 0 });
  changed(); pushAllTeams();
}

// timer loop: fire scheduled flash news and lock rounds on time
setInterval(() => {
  if (!db) return;
  const g = G();
  if (g.status !== 'running') return;
  const r = curRound();
  const t = now();
  const elapsedSec = num(r.durationSec, 720) - (g.endsAt - t) / 1000;
  (r.flash || []).forEach((f, i) => {
    if (!g.firedIdx.includes(i) && f.text && elapsedSec >= num(f.atSec)) {
      g.firedIdx.push(i);
      g.fired.push({ text: f.text, at: t });
      io.emit('flash', { text: f.text });
      changed();
    }
  });
  if (t >= g.endsAt) settleRound();
}, 250);

const tradingOpen = () => G().status === 'running' && now() < G().endsAt;

function trade(team, resId, side, qty) {
  const g = G(), r = curRound();
  if (!tradingOpen()) throw new Error(g.status === 'paused' ? 'Trading is paused.' : 'Trading is closed for this round.');
  const res = resById(resId);
  if (!res) throw new Error('Unknown resource.');
  qty = int(qty);
  if (qty <= 0) throw new Error('Enter a quantity of at least 1.');
  const price = num(r.prices?.[resId]);
  team.inventory[resId] = team.inventory[resId] || 0;
  if (side === 'buy') {
    const bought = (g.bought[team.id] ||= {});
    const cap = capFor(r, resId);
    const already = bought[resId] || 0;
    if (already + qty > cap) throw new Error(`You can buy only ${Math.max(0, cap - already)} more ${res.name} this round.`);
    if ((g.market[resId] || 0) < qty) throw new Error(`Only ${g.market[resId] || 0} ${res.name} left in the market.`);
    const cost = qty * price;
    if (cost > team.cash) throw new Error(`Not enough credits. This costs ${cost.toLocaleString('en-IN')}.`);
    team.cash -= cost;
    team.inventory[resId] += qty;
    bought[resId] = already + qty;
    g.market[resId] -= qty;
  } else if (side === 'sell') {
    if (team.inventory[resId] < qty) throw new Error(`You hold only ${team.inventory[resId]} ${res.name}.`);
    team.cash += qty * price;
    team.inventory[resId] -= qty;
    g.market[resId] = (g.market[resId] || 0) + qty;
    const plan = g.plans[team.id];
    if (plan && plan[resId] > team.inventory[resId]) plan[resId] = team.inventory[resId];
  } else throw new Error('Choose buy or sell.');
  changed(team);
}

function setPlan(team, plan) {
  if (!tradingOpen()) throw new Error('Generation is locked for this round.');
  const clean = {};
  for (const res of db.resources) clean[res.id] = Math.min(Math.max(0, int(plan?.[res.id] || 0)), int(team.inventory[res.id] || 0));
  G().plans[team.id] = clean;
  changed(team);
}

function createTeam({ name, members, password }, { admin = false } = {}) {
  const c = db.config;
  name = String(name || '').trim();
  members = (Array.isArray(members) ? members : []).map((m) => String(m || '').trim()).filter(Boolean);
  if (name.length < 2 || name.length > 40) throw new Error('Team name must be 2 to 40 characters.');
  if (db.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new Error('That team name is taken.');
  if (!admin) {
    if (!c.registrationOpen) throw new Error('Registration is closed.');
    if (members.length < num(c.teamSizeMin) || members.length > num(c.teamSizeMax))
      throw new Error(`Teams need ${c.teamSizeMin === c.teamSizeMax ? c.teamSizeMin : c.teamSizeMin + ' to ' + c.teamSizeMax} members.`);
  }
  if (String(password || '').length < 4) throw new Error('Password must be at least 4 characters.');
  const team = {
    id: crypto.randomBytes(6).toString('hex'), name, members, pw: hashPw(password), tokens: [],
    cash: num(c.startingCredits), inventory: {}, history: [], powerPoints: 0, blackouts: 0, createdAt: now(),
  };
  db.teams.push(team);
  // a team joining mid-round brings its share of market supply with it
  const r = curRound();
  if (r && ['running', 'paused'].includes(G().status)) {
    for (const x of db.resources) G().market[x.id] = (G().market[x.id] || 0) + Math.round(num(r.supplyPerTeam?.[x.id]));
  }
  changed();
  return team;
}

// ---------------------------------------------------------------- http
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const adminTokens = new Set();
const wrap = (fn) => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) { res.status(e.status || 400).json({ error: e.message || 'Request failed.' }); }
};
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
function teamAuth(req) {
  const t = bearer(req);
  const team = t && db.teams.find((x) => x.tokens?.includes(t));
  if (!team) { const e = new Error('Your session has expired. Log in again.'); e.status = 401; throw e; }
  return team;
}
function adminAuth(req) {
  if (!adminTokens.has(bearer(req))) { const e = new Error('Admin login required.'); e.status = 401; throw e; }
}

app.get('/api/public', wrap(() => publicState()));
app.post('/api/register', wrap((req) => {
  const team = createTeam(req.body || {});
  const t = token(); team.tokens.push(t); save();
  return { token: t, team: teamView(team) };
}));
app.post('/api/login', wrap((req) => {
  const { name, password } = req.body || {};
  const team = db.teams.find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase());
  if (!team || !checkPw(password, team.pw)) throw new Error('Team name or password is incorrect.');
  const t = token();
  team.tokens = [...(team.tokens || []).slice(-4), t];
  save();
  return { token: t, team: teamView(team) };
}));
app.get('/api/me', wrap((req) => teamView(teamAuth(req))));
app.post('/api/trade', wrap((req) => {
  const team = teamAuth(req);
  const { resource, side, qty } = req.body || {};
  trade(team, resource, side, qty);
  return teamView(team);
}));
app.post('/api/plan', wrap((req) => {
  const team = teamAuth(req);
  setPlan(team, req.body?.plan);
  return teamView(team);
}));

// admin
app.post('/api/admin/login', wrap((req) => {
  if (String(req.body?.password || '') !== ADMIN_PASSWORD) throw new Error('Wrong admin password.');
  const t = token(); adminTokens.add(t); return { token: t };
}));
app.get('/api/admin/state', wrap((req) => { adminAuth(req); return adminView(); }));

app.put('/api/admin/config', wrap((req) => {
  adminAuth(req);
  const body = req.body || {};
  for (const k of Object.keys(db.config)) {
    if (!(k in body)) continue;
    const old = db.config[k];
    db.config[k] = typeof old === 'number' ? num(body[k], old) : typeof old === 'boolean' ? body[k] === true || body[k] === 'true' : String(body[k]);
  }
  changed(); pushAllTeams();
  return adminView();
}));

app.put('/api/admin/resources', wrap((req) => {
  adminAuth(req);
  const list = req.body?.resources;
  if (!Array.isArray(list) || !list.length) throw new Error('Add at least one resource.');
  const ids = new Set();
  db.resources = list.map((x) => {
    const id = String(x.id || x.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!id) throw new Error('Every resource needs a name.');
    if (ids.has(id)) throw new Error(`Two resources share the id "${id}".`);
    ids.add(id);
    return { id, name: String(x.name || id), color: String(x.color || '#888888'), green: !!x.green, storable: !!x.storable, weather: !!x.weather, endValue: num(x.endValue) };
  });
  changed(); pushAllTeams();
  return adminView();
}));

app.put('/api/admin/rounds', wrap((req) => {
  adminAuth(req);
  const list = req.body?.rounds;
  if (!Array.isArray(list) || !list.length) throw new Error('Add at least one round.');
  const resMap = (o, d) => Object.fromEntries(db.resources.map((x) => [x.id, num(o?.[x.id], d)]));
  db.rounds = list.map((x, i) => ({
    id: x.id || 'r' + (i + 1) + '-' + crypto.randomBytes(2).toString('hex'),
    title: String(x.title || `Round ${i + 1}`),
    durationSec: Math.max(10, num(x.durationSec, 720)),
    target: Math.max(1, num(x.target, 100)),
    multiplier: num(x.multiplier, 1),
    hideLeaderboard: !!x.hideLeaderboard,
    capMultiplier: num(x.capMultiplier, 2),
    caps: Object.fromEntries(Object.entries(x.caps || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, num(v)])),
    prices: resMap(x.prices, 0),
    supplyPerTeam: resMap(x.supplyPerTeam, 0),
    efficiency: resMap(x.efficiency, 100),
    carbonTax: resMap(x.carbonTax, 0),
    headlines: (x.headlines || []).map(String).filter((s) => s.trim()),
    flash: (x.flash || []).filter((f) => f && String(f.text || '').trim()).map((f) => ({ atSec: num(f.atSec), text: String(f.text) })),
  }));
  if (G().roundIndex >= db.rounds.length) G().roundIndex = db.rounds.length - 1;
  changed();
  return adminView();
}));

app.post('/api/admin/teams', wrap((req) => { adminAuth(req); createTeam(req.body || {}, { admin: true }); return adminView(); }));
app.put('/api/admin/teams/:id', wrap((req) => {
  adminAuth(req);
  const team = teamById(req.params.id);
  if (!team) throw new Error('Team not found.');
  const b = req.body || {};
  if (b.name != null) {
    const n = String(b.name).trim();
    if (db.teams.some((t) => t !== team && t.name.toLowerCase() === n.toLowerCase())) throw new Error('That team name is taken.');
    if (n.length >= 2) team.name = n;
  }
  if (Array.isArray(b.members)) team.members = b.members.map(String).map((s) => s.trim()).filter(Boolean);
  if (b.cash != null && b.cash !== '') team.cash = num(b.cash, team.cash);
  if (b.powerPoints != null && b.powerPoints !== '') team.powerPoints = num(b.powerPoints, team.powerPoints);
  if (b.inventory) for (const [k, v] of Object.entries(b.inventory)) team.inventory[k] = Math.max(0, int(v));
  if (b.password) {
    if (String(b.password).length < 4) throw new Error('Password must be at least 4 characters.');
    team.pw = hashPw(b.password); team.tokens = [];
  }
  changed(team);
  return adminView();
}));
app.delete('/api/admin/teams/:id', wrap((req) => {
  adminAuth(req);
  db.teams = db.teams.filter((t) => t.id !== req.params.id);
  changed();
  return adminView();
}));

app.post('/api/admin/control', wrap((req) => {
  adminAuth(req);
  const g = G();
  const { action, seconds, text } = req.body || {};
  switch (action) {
    case 'start': startNextRound(); break;
    case 'pause':
      if (g.status !== 'running') throw new Error('No running round to pause.');
      g.remainingMs = Math.max(0, g.endsAt - now()); g.status = 'paused'; changed(); break;
    case 'resume':
      if (g.status !== 'paused') throw new Error('The round is not paused.');
      g.endsAt = now() + g.remainingMs; g.status = 'running'; changed(); break;
    case 'extend': {
      const ms = num(seconds, 60) * 1000;
      if (g.status === 'running') g.endsAt = Math.max(now() + 1000, g.endsAt + ms);
      else if (g.status === 'paused') g.remainingMs = Math.max(1000, g.remainingMs + ms);
      else throw new Error('No active round to change.');
      changed(); break;
    }
    case 'end':
      if (!['running', 'paused'].includes(g.status)) throw new Error('No active round to end.');
      settleRound(); break;
    case 'flash':
      if (!['running', 'paused'].includes(g.status)) throw new Error('Flash news can only be sent during a round.');
      if (!String(text || '').trim()) throw new Error('Write the flash news first.');
      g.fired.push({ text: String(text), at: now() }); io.emit('flash', { text: String(text) }); changed(); break;
    case 'finish': finishGame(); break;
    case 'reset-game': resetGame(); break;
    case 'reset-all': { const keep = db.teams; db = freshDb(); db.teams = keep; resetGame(); break; }
    case 'delete-all-teams': db.teams = []; changed(); break;
    default: throw new Error('Unknown action.');
  }
  return adminView();
}));

app.get('/api/admin/export.csv', (req, res) => {
  if (!adminTokens.has(String(req.query.token || ''))) return res.status(401).send('Admin login required.');
  const rows = [['Rank', 'Team', 'Members', 'Total', 'Power points', 'Trading points', 'Net worth', 'Cash', 'Blackouts']];
  for (const l of leaderboard()) {
    const t = teamById(l.id);
    rows.push([l.rank, t.name, (t.members || []).join(' & '), l.total, l.powerPoints, l.tradingPoints, l.netWorth, Math.round(t.cash), l.blackouts]);
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="powerplay-results.csv"');
  res.send(rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'));
});

// ---------------------------------------------------------------- sockets
const server = http.createServer(app);
io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });
io.on('connection', (socket) => {
  const { token: tk, role } = socket.handshake.auth || {};
  if (role === 'admin') {
    if (adminTokens.has(tk)) { socket.join('admin'); socket.emit('admin', adminView()); }
  } else if (tk) {
    const team = db.teams.find((x) => x.tokens?.includes(tk));
    if (team) { socket.join('team:' + team.id); socket.emit('team', teamView(team)); }
    else socket.emit('auth-failed');
  }
  socket.emit('public', publicState());
});

(async () => {
  if (kvOn) {
    try { const remote = await kvGet(); if (remote) { db = remote; console.log('[kv] loaded saved game from Upstash'); } }
    catch (e) { console.error('[kv]', e.message); }
  }
  if (!db) { db = freshDb(); console.log('[db] starting fresh'); }
  server.listen(PORT, () => console.log(`[powerplay] port ${PORT}  admin: /admin  projector: /screen  backup: ${kvOn ? 'Upstash' : 'local file only'}`));
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { writeNow(); kvBusy = false; await kvPut(); process.exit(0); });
