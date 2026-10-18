import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.NIMBUS_DATA || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'nimbus.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  color TEXT DEFAULT '#c9c2f0',
  effort TEXT DEFAULT 'medium',
  model TEXT DEFAULT '',
  approval_rules TEXT DEFAULT '[]',
  allow_rules TEXT DEFAULT '[]',
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  goal TEXT DEFAULT '',
  lead_bot_id INTEGER,
  bots_can_talk INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id INTEGER, bot_id INTEGER, PRIMARY KEY (room_id, bot_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  run_id INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread, id);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER, thread TEXT, status TEXT DEFAULT 'queued',
  prompt TEXT, session_id TEXT, cost_usd REAL DEFAULT 0, effort TEXT,
  started_at INTEGER, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  bot_id INTEGER, thread TEXT, session_id TEXT, PRIMARY KEY (bot_id, thread)
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER, bot_id INTEGER, thread TEXT, tool TEXT, input TEXT,
  status TEXT DEFAULT 'pending', note TEXT,
  created_at INTEGER DEFAULT (unixepoch()), decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER, cron TEXT, prompt TEXT, enabled INTEGER DEFAULT 1, last_run INTEGER
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, secrets TEXT DEFAULT '{}', installed_at INTEGER DEFAULT (unixepoch()));
CREATE TABLE IF NOT EXISTS bot_plugins (bot_id INTEGER, plugin_id TEXT, PRIMARY KEY (bot_id, plugin_id));
`);
for (const [col, type] of [['shape', "TEXT DEFAULT 'blob'"], ['template', "TEXT DEFAULT ''"], ['computer', 'INTEGER DEFAULT 0']]) {
  if (!db.prepare('PRAGMA table_info(bots)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE bots ADD COLUMN ${col} ${type}`);
}

export const q = (sql) => db.prepare(sql);

export function parseBot(b) {
  if (!b) return b;
  return { ...b, computer: Number(b.computer) ? 1 : 0, approval_rules: JSON.parse(b.approval_rules || '[]'), allow_rules: JSON.parse(b.allow_rules || '[]') };
}

export function botDir(id) {
  const dir = path.join(DATA_DIR, 'bots', String(id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Every bot can message every other bot with bin/ask-bot.mjs (see /api/hook/ask in server.js).
const ASK_BOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'bin', 'ask-bot.mjs');
function teamSection(bot, remote) {
  // Bots on their own computer get a copy of the script in their work folder (see remoteRun in runner.js).
  const ask = remote ? '/config/work/ask-bot.mjs' : ASK_BOT;
  const others = db.prepare('SELECT id, name, role FROM bots WHERE id != ? ORDER BY id').all(bot.id);
  if (!others.length) return 'You are the only bot right now.';
  return `Other Nimbus bots you can message (they are bots, not the user):
${others.map((o) => `- ${o.name} (#${o.id})${o.role ? `: ${o.role}` : ''}`).join('\n')}

To ask a bot something and get its answer back, run (Bash tool, timeout 600000):
  node ${ask} "<bot name or #id>" "<message>"
To just send it information or a task without waiting: add --no-wait before the name.
If an answer takes longer than ~4 minutes you get a run id; fetch it later with: node ${ask} --result <run id>
- Write messages that stand on their own: the other bot can't see this chat. Include the facts, files (full paths) and what you need back.
- Ask a teammate when the work is in its area (e.g. calendar, firewall, Proxmox) instead of doing it yourself.
- Don't message the bot that is asking you something; put your answer in your reply instead.${remote ? `
- You run on your own computer, where the Claude connectors (Gmail, Google Calendar, Drive, Docs) are not
  available. For anything in those, ask a teammate that runs on the Nimbus server (e.g. a calendar bot).
- Files you save under ~/Downloads or ~/work show up in Nimbus (computer dialog → Files), so the user can download them.` : ''}`;
}

// Each bot gets a workspace folder. CLAUDE.md there is its standing brief;
// MEMORY.md is what it has learned, which it edits itself.
export { ASK_BOT };
export function writeBotBrief(bot, remote = false) {
  const dir = botDir(bot.id);
  const mem = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, `# What ${bot.name} has learned\n\n`);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# You are ${bot.name}
${bot.role ? `Role: ${bot.role}\n` : ''}
You are one bot on the user's personal team in an app called Nimbus. You run headless:
the user is not watching the terminal. They read your final reply in a chat thread.

## Standing instructions
${bot.instructions || '(none yet)'}

## How to work
- Do the work, then reply briefly: what you did, what needs the user, what's next.
- Risky actions (sending, paying, deleting, pushing, merging) may be paused for the user's
  approval automatically. If one is rejected, read the reason and adjust.
- When the user tells you a preference or rule, add one line to MEMORY.md in this folder.
- This folder is your workspace. Keep notes and files here.

## Your team
${teamSection(bot, remote)}

## Memory
@MEMORY.md
`);
  return dir;
}

// Server settings edited in the app (Settings → Server). Values here override the matching env vars.
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
export function getSetting(key, envName) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : (envName ? process.env[envName] || '' : '');
}
export function setSetting(key, value) {
  if (value === '' || value == null) db.prepare('DELETE FROM settings WHERE key=?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'files')) db.exec("ALTER TABLE messages ADD COLUMN files TEXT DEFAULT '[]'");
if (!db.prepare('PRAGMA table_info(runs)').all().some((c) => c.name === 'parent_run')) db.exec('ALTER TABLE runs ADD COLUMN parent_run INTEGER');
