const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

console.log('Starting Poxel FC 27 Database Server...');

let db;
try {
  db = new Database('poxel_fc27.db', { verbose: console.log });
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
  console.log('SQLite database initialized successfully.');
} catch (err) {
  console.error('Database initialization failed:', err);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/user/create', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ success: false, error: 'Username required' });
  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO users (username, squad, settings) VALUES (?, ?, ?)');
    stmt.run(username, JSON.stringify([]), JSON.stringify({ assist: 'full', sound: true }));
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/user/:username', (req, res) => {
  const { username } = req.params;
  try {
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      db.prepare('INSERT INTO users (username, squad, settings) VALUES (?, ?, ?)').run(username, '[]', '{}');
      user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    }
    let squadParsed = [];
    try { squadParsed = JSON.parse(user.squad); } catch(e) {}
    let settingsParsed = {};
    try { settingsParsed = JSON.parse(user.settings); } catch(e) {}

    res.json({ success: true, data: { ...user, squad: squadParsed, settings: settingsParsed } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/user/save', (req, res) => {
  const { username, level, xp, coins, gems, trophies, squad, settings } = req.body;
  try {
    const existing = db.prepare('SELECT squad FROM users WHERE username = ?').get(username);
    let finalSquad = squad || [];

    // Safeguard: If the server database contains rich player objects (from admin grants), 
    // never let an incoming client sync wipe them out with basic ID arrays.
    if (existing && existing.squad) {
      try {
        let dbSquad = JSON.parse(existing.squad);
        let dbList = Array.isArray(dbSquad) ? dbSquad : (dbSquad.owned || []);
        if (dbList.length > 0 && typeof dbList[0] === 'object') {
          finalSquad = dbSquad;
        }
      } catch(e) {}
    }

    db.prepare(`
      UPDATE users SET level = ?, xp = ?, coins = ?, gems = ?, trophies = ?, squad = ?, settings = ?, updated_at = CURRENT_TIMESTAMP
      WHERE username = ?
    `).run(level, xp, coins, gems, trophies, JSON.stringify(finalSquad), JSON.stringify(settings || {}), username);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/grant-player', (req, res) => {
  const { username, player, adminKey } = req.body;
  if (adminKey !== 'MY_SECRET_OWNER_KEY_123') {
    return res.status(403).json({ success: false, error: 'Unauthorized: Wrong admin key' });
  }
  if (!username || !player) return res.status(400).json({ success: false, error: 'Username and player required' });
  try {
    let user = db.prepare('SELECT squad FROM users WHERE username = ?').get(username);
    if (!user) {
      db.prepare('INSERT INTO users (username, squad, settings) VALUES (?, ?, ?)').run(username, '[]', '{}');
      user = db.prepare('SELECT squad FROM users WHERE username = ?').get(username);
    }

    let squadData = [];
    try { squadData = JSON.parse(user.squad || '[]'); } catch(e) { squadData = []; }

    if (Array.isArray(squadData)) {
      if (!squadData.some(p => p && p.id === player.id)) squadData.push(player);
    } else if (squadData && typeof squadData === 'object') {
      if (!Array.isArray(squadData.owned)) squadData.owned = [];
      if (!squadData.owned.some(p => p && p.id === player.id)) squadData.owned.push(player);
    }

    db.prepare('UPDATE users SET squad = ? WHERE username = ?').run(JSON.stringify(squadData), username);
    res.json({ success: true, message: `Granted ${player.name} to ${username}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running and listening permanently on port ${PORT}`);
});

