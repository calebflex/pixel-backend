const Database = require('better-sqlite3');
const db = new Database('poxel_fc27.db', { verbose: console.log });

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

module.exports = db;
