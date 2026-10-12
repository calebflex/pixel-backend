const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

console.log('Starting Poxel FC 27 Database Server...');

// ---- config (set these in Render > Environment) ----
const ADMIN_KEY = process.env.ADMIN_KEY || '';          // REQUIRED for admin grants
const DB_PATH = process.env.DB_PATH || 'poxel_fc27.db'; // point at a Render Disk (e.g. /data/poxel_fc27.db) so data survives restarts
const NUM = ['level', 'xp', 'coins', 'gems', 'tokens', 'trophies'];

let ROSTER = [];
try { ROSTER = require('./roster.json'); } catch (e) { console.warn('roster.json missing: players can only be granted by numeric id'); }

let db;
try {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      level INTEGER DEFAULT 1,
      xp INTEGER DEFAULT 0,
      coins INTEGER DEFAULT 25000,
      gems INTEGER DEFAULT 450,
      trophies INTEGER DEFAULT 0,
      squad TEXT DEFAULT '[]',
      settings TEXT DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // migrations for older databases
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('tokens')) db.exec('ALTER TABLE users ADD COLUMN tokens INTEGER DEFAULT 0');
  if (!cols.includes('pending')) db.exec("ALTER TABLE users ADD COLUMN pending TEXT DEFAULT '{}'");
  console.log('SQLite database initialized successfully at', DB_PATH);
} catch (err) {
  console.error('Database initialization failed:', err);
  process.exit(1);
}

const jparse = (s, d) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : d; } catch (e) { return d; } };
const num = v => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };

/* squad is stored as { owned:[playerIds], lineup:[playerIds], clubName } (what the game sends).
   Old rows may hold '[]' or objects - normalise to ids. */
function readSquad(raw) {
  let sq = jparse(raw, {});
  if (Array.isArray(sq)) sq = {};
  const ids = (sq.owned || []).map(x => (x && typeof x === 'object' ? num(x.id) : num(x))).filter(x => x !== null);
  return { owned: [...new Set(ids)], lineup: Array.isArray(sq.lineup) ? sq.lineup : [], clubName: sq.clubName || 'Poxel FC' };
}

const pendingEmpty = p => !p || (!Object.keys(p.add || {}).length && !Object.keys(p.set || {}).length && !(p.players || []).length);

/* Admin grants are stored as "pending" and merged the next time the player loads or saves.
   This is what stops the game's 30s auto-save from overwriting your grant with the player's old numbers. */
function applyPending(values, squad, pending) {
  if (pendingEmpty(pending)) return false;
  for (const [k, v] of Object.entries(pending.set || {})) if (NUM.includes(k)) values[k] = v;
  for (const [k, v] of Object.entries(pending.add || {})) if (NUM.includes(k)) values[k] = (values[k] || 0) + v;
  for (const id of pending.players || []) if (!squad.owned.includes(id)) squad.owned.push(id);
  return true;
}

const publicUser = (row, squad) => ({
  id: row.id, username: row.username, level: row.level, xp: row.xp, coins: row.coins, gems: row.gems,
  tokens: row.tokens || 0, trophies: row.trophies, squad, settings: jparse(row.settings, {}), updated_at: row.updated_at
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

app.get('/', (req, res) => res.send('Poxel FC 27 server is running'));

app.post('/api/user/create', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ success: false, error: 'Username required' });
  try {
    db.prepare('INSERT OR IGNORE INTO users (username, squad, settings) VALUES (?, ?, ?)')
      .run(username, JSON.stringify({ owned: [], lineup: [], clubName: 'Poxel FC' }), JSON.stringify({ assist: 'full', sound: true }));
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    res.json({ success: true, data: publicUser(row, readSquad(row.squad)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/user/:username', (req, res) => {
  const { username } = req.params;
  try {
    let row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) {
      db.prepare('INSERT INTO users (username, squad, settings) VALUES (?, ?, ?)').run(username, '{}', '{}');
      row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    }
    const squad = readSquad(row.squad);
    const pending = jparse(row.pending, {});
    const values = {}; NUM.forEach(k => values[k] = row[k] || 0);
    if (applyPending(values, squad, pending)) {
      db.prepare(`UPDATE users SET level=@level, xp=@xp, coins=@coins, gems=@gems, tokens=@tokens, trophies=@trophies,
                  squad=@squad, pending='{}', updated_at=CURRENT_TIMESTAMP WHERE username=@username`)
        .run({ ...values, squad: JSON.stringify(squad), username });
      row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    }
    res.json({ success: true, data: publicUser(row, squad) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/user/save', (req, res) => {
  const { username, squad: clientSquad, settings } = req.body;
  if (!username) return res.status(400).json({ success: false, error: 'Username required' });
  try {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) return res.status(404).json({ success: false, error: 'User not found' });
    const values = {};
    NUM.forEach(k => { const n = num(req.body[k]); values[k] = n === null ? (row[k] || 0) : n; });
    const squad = readSquad(JSON.stringify(clientSquad || {}));
    applyPending(values, squad, jparse(row.pending, {}));
    db.prepare(`UPDATE users SET level=@level, xp=@xp, coins=@coins, gems=@gems, tokens=@tokens, trophies=@trophies,
                squad=@squad, settings=@settings, pending='{}', updated_at=CURRENT_TIMESTAMP WHERE username=@username`)
      .run({ ...values, squad: JSON.stringify({ ...(clientSquad || {}), owned: squad.owned, lineup: squad.lineup, clubName: squad.clubName }),
             settings: JSON.stringify(settings || {}), username });
    const fresh = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    // returning the merged profile lets the game pick up grants immediately
    res.json({ success: true, data: publicUser(fresh, readSquad(fresh.squad)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ===================== ADMIN =====================
   Auth: header  x-admin-key: <ADMIN_KEY env var>
   POST /api/admin/grant
     { username, mode: "add" | "set", coins, gems, tokens, xp, level, trophies, players: [1380, "Ruud Gullit"] }
   GET  /api/admin/players?q=rodri     -> look up player ids
   GET  /api/admin/user/:username      -> see a player's row + pending grants */
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || '';
  if (!ADMIN_KEY) return res.status(503).json({ success: false, error: 'ADMIN_KEY is not set on the server' });
  if (key !== ADMIN_KEY) return res.status(403).json({ success: false, error: 'Wrong admin key' });
  next();
}

function resolvePlayer(p) {
  const id = num(p);
  if (id !== null && String(p).trim() !== '' && /^\d+$/.test(String(p).trim())) return ROSTER.length && !ROSTER.some(r => r.id === id) ? null : id;
  const name = String(p).trim().toLowerCase();
  const hit = ROSTER.find(r => r.name.toLowerCase() === name) || ROSTER.find(r => r.name.toLowerCase().includes(name));
  return hit ? hit.id : null;
}

app.get('/api/admin/players', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  res.json({ success: true, data: ROSTER.filter(r => r.name.toLowerCase().includes(q)).slice(0, 50) });
});

app.get('/api/admin/user/:username', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!row) return res.status(404).json({ success: false, error: 'User not found' });
  res.json({ success: true, data: { ...publicUser(row, readSquad(row.squad)), pending: jparse(row.pending, {}) } });
});

app.post('/api/admin/grant', requireAdmin, (req, res) => {
  const { username, mode = 'add', players = [] } = req.body;
  if (!username) return res.status(400).json({ success: false, error: 'username required' });
  if (!['add', 'set'].includes(mode)) return res.status(400).json({ success: false, error: 'mode must be add or set' });
  try {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) return res.status(404).json({ success: false, error: 'User not found: ' + username });
    const pending = jparse(row.pending, {});
    pending.add = pending.add || {}; pending.set = pending.set || {}; pending.players = pending.players || [];
    const applied = {};
    for (const k of NUM) {
      const n = num(req.body[k]);
      if (n === null) continue;
      if (mode === 'set') { pending.set[k] = n; delete pending.add[k]; }
      else pending.add[k] = (pending.add[k] || 0) + n;
      applied[k] = n;
    }
    const granted = [], notFound = [];
    for (const p of [].concat(players)) {
      const id = resolvePlayer(p);
      if (id === null) { notFound.push(p); continue; }
      if (!pending.players.includes(id)) pending.players.push(id);
      granted.push(id);
    }
    db.prepare('UPDATE users SET pending = ? WHERE username = ?').run(JSON.stringify(pending), username);
    console.log(`>>> ADMIN GRANT -> ${username} | mode=${mode} | ${JSON.stringify(applied)} | players=${JSON.stringify(granted)}`);
    res.json({ success: true, applied, players: granted, notFound,
      note: 'Applied the next time the player opens the game or auto-saves (within ~30s if they are online).' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running and listening permanently on port ${PORT}`);
});
