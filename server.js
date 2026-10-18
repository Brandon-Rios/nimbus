import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, q, parseBot, botDir, writeBotBrief, DATA_DIR, getSetting, setSetting } from './db.js';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { redact } from './redact.js';
import { addClient, broadcast } from './events.js';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { CLAUDE_BIN, computersOn, agentConfig, agent, runBot, stopRun, addMessage, updateMessage, botStatus, roomMembers, findMentions, markTraceWaiting, recoverRuns, HOOK_TOKEN } from './runner.js';
import { TEMPLATES, PLUGINS, publicPlugin } from './catalog.js';
import { startScheduler, nextRun, isValidCron } from './scheduler.js';
import { getPlanUsage } from './planusage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.PORT || 8787);
process.env.PORT = String(PORT);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.NIMBUS_PASSWORD || '';
const ALLOWED_EMAILS = (process.env.NIMBUS_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const WINDOW_BUDGET = Number(process.env.NIMBUS_WINDOW_BUDGET_USD || 0);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

recoverRuns();
startScheduler();

// ---------- approvals ----------
function globToRe(glob) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'is');
}
function toolArg(input = {}) {
  return String(input.command ?? input.file_path ?? input.url ?? JSON.stringify(input));
}
function ruleMatches(rule, tool, input) {
  const m = rule.match(/^([^(]+)\((.*)\)$/s);
  if (m) return globToRe(m[1].trim()).test(tool) && globToRe(m[2]).test(toolArg(input));
  return globToRe(rule.trim()).test(tool);
}
// "@self-email" in a bot's Always-allow rules lets it send email only to the Nimbus owner's own
// addresses (NIMBUS_ALLOWED_EMAILS) without asking; mail to anyone else still waits for approval.
function isSelfEmail(tool, input = {}) {
  if (!/Gmail__(send_message|create_draft)$/i.test(tool)) return false;
  const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).replace(/^.*<|>.*$/g, '').trim().toLowerCase()).filter(Boolean);
  const all = [...list(input.to), ...list(input.cc), ...list(input.bcc)];
  return all.length > 0 && all.every((e) => ALLOWED_EMAILS.includes(e));
}
// The rule "Always allow" saves: the exact command, or a prefix pattern of its first words.
function rememberRule(tool, input, kind) {
  if (tool !== 'Bash') return tool;
  const cmd = String(input.command || '').trim();
  if (kind !== 'pattern') return `Bash(${cmd})`;
  return `Bash(${commandPrefix(cmd)}*)`;
}
function commandPrefix(cmd) {
  const words = cmd.split(/\s+/);
  const keep = [];
  for (const w of words) { if (keep.length >= 2 || /^[-'"$|;&><]/.test(w)) break; keep.push(w); }
  return (keep.join(' ') || words[0]) + ' ';
}
const waiters = new Map(); // approvalId -> Set(resolve)
function notifyApproval(id) {
  for (const fn of waiters.get(id) || []) fn();
  waiters.delete(id);
}

// ---------- helpers ----------
const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
async function body(req, limit = 2e6) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > limit) throw new Error('too large'); }
  return s ? JSON.parse(s) : {};
}
function tailMemory(botId, n = 3) {
  try {
    return fs.readFileSync(path.join(botDir(botId), 'MEMORY.md'), 'utf8').split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim()).filter((l) => l && !l.startsWith('#')).slice(-n);
  } catch { return []; }
}
function botView(b) {
  const st = botStatus.get(b.id) || { state: 'idle', label: 'Idle' };
  const today = q("SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(ended_at-started_at),0) AS secs FROM runs WHERE bot_id=? AND started_at >= unixepoch('now','localtime','start of day','utc')").get(b.id);
  const pending = q("SELECT COUNT(*) AS n FROM approvals WHERE bot_id=? AND status='pending'").get(b.id).n;
  return { ...b, status: pending ? { state: 'waiting', label: 'Waiting on you' } : st, today };
}

function state(req) {
  const bots = q('SELECT * FROM bots ORDER BY id').all().map(parseBot).map(botView);
  const rooms = q('SELECT * FROM rooms ORDER BY id').all().map((r) => ({ ...r, members: roomMembers(r.id).map((m) => m.id) }));
  const approvals = q("SELECT * FROM approvals WHERE status='pending' ORDER BY id").all().map((a) => ({ ...a, input: JSON.parse(a.input || '{}') }));
  const routines = q('SELECT * FROM routines ORDER BY id').all();
  const upNext = routines.filter((r) => r.enabled).map((r) => ({ ...r, next: nextRun(r.cron)?.getTime() }))
    .filter((r) => r.next).sort((a, b) => a.next - b.next).slice(0, 6);
  const learned = bots.flatMap((b) => tailMemory(b.id, 2).map((text) => ({ botId: b.id, text }))).slice(-5);
  const windowCost = q("SELECT COALESCE(SUM(cost_usd),0) AS c FROM runs WHERE started_at >= unixepoch() - 5*3600").get().c;
  const running = q("SELECT COUNT(*) AS n FROM runs WHERE status='running'").get().n;
  // Share of the last 7 days' usage per bot (Claude Code's reported cost, used as a relative measure).
  const byBot = q("SELECT bot_id, COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost FROM runs WHERE started_at >= unixepoch() - 7*86400 GROUP BY bot_id ORDER BY cost DESC").all();
  const last = {};
  for (const m of q(`SELECT m.thread, m.author, m.kind, m.body, m.created_at FROM messages m
      JOIN (SELECT thread, MAX(id) AS id FROM messages WHERE kind IN ('text','error','approval') GROUP BY thread) x ON x.id = m.id`).all()) {
    let text = m.body;
    if (m.kind === 'approval') { try { text = 'Needs approval: ' + JSON.parse(m.body).tool; } catch {} }
    last[m.thread] = { author: m.author, text: String(text).replace(/\s+/g, ' ').slice(0, 120), at: m.created_at };
  }
  const botPlugins = {};
  for (const r of q('SELECT * FROM bot_plugins').all()) (botPlugins[r.bot_id] ||= []).push(r.plugin_id);
  for (const b of bots) b.plugins = botPlugins[b.id] || [];
  const installed = q('SELECT id FROM plugins').all().map((r) => r.id);
  return { bots, rooms, approvals, routines, upNext, learned, last, installed, user: req?.user || null, computers: computersOn(), proxmox: !!pveConfig(), usage: { windowCost, budget: WINDOW_BUDGET, running, byBot } };
}

function postToThread(thread, text, files = []) {
  const msg = addMessage(thread, 'user', 'text', text, null, files);
  // Bots see attachments as file paths; Claude Code's Read tool opens images and PDFs too.
  if (files.length) text = `${text || 'See the attached files.'}\n\nAttached files (open them with the Read tool):\n` + files.map((f) => `- ${uploadPath(f)} (${f.type || 'file'}, ${f.size} bytes)`).join('\n');
  if (thread.startsWith('bot:')) {
    runBot({ botId: Number(thread.slice(4)), thread, prompt: text });
  } else if (thread.startsWith('room:')) {
    const roomId = Number(thread.slice(5));
    const room = q('SELECT * FROM rooms WHERE id=?').get(roomId);
    const members = roomMembers(roomId);
    let targets = findMentions(text, members);
    if (!targets.length) targets = members.filter((m) => m.id === room.lead_bot_id);
    if (!targets.length && members[0]) targets = [members[0]];
    for (const t of targets) runBot({ botId: t.id, thread, prompt: text, source: 'the user' });
  }
  return msg;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/state', (req, res) => json(res, 200, state(req)));

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  addClient(res);
});

route('GET', '/api/threads/:thread/messages', (req, res, p, url) => {
  const before = Number(url.searchParams.get('before') || 1e15);
  const rows = q('SELECT * FROM messages WHERE thread=? AND id<? ORDER BY id DESC LIMIT 80').all(decodeURIComponent(p.thread), before).reverse();
  json(res, 200, rows);
});

route('POST', '/api/threads/:thread/messages', async (req, res, p) => {
  const { text = '', files: ids = [] } = await body(req);
  const files = (Array.isArray(ids) ? ids : []).slice(0, 10).map(readUpload).filter(Boolean);
  if (!String(text).trim() && !files.length) return json(res, 400, { error: 'empty' });
  json(res, 200, postToThread(decodeURIComponent(p.thread), String(text).trim(), files));
});

// ---------- uploads ----------
// Each upload lives in data/uploads/<id>/ with the original file and meta.json.
const UPLOADS = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD = 20 * 1024 * 1024;
const safeName = (n) => String(n || 'file').replace(/[\/\\\0]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';
const uploadPath = (f) => path.join(UPLOADS, f.id, f.name);
function readUpload(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(UPLOADS, id, 'meta.json'), 'utf8')); } catch { return null; }
}
route('POST', '/api/uploads', async (req, res) => {
  const { name, type, data } = await body(req, Math.ceil(MAX_UPLOAD * 1.4) + 1000);
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) return json(res, 400, { error: 'Empty file' });
  if (buf.length > MAX_UPLOAD) return json(res, 413, { error: 'Files can be up to 20 MB' });
  const f = { id: crypto.randomBytes(12).toString('hex'), name: safeName(name), type: String(type || '').slice(0, 100), size: buf.length };
  fs.mkdirSync(path.join(UPLOADS, f.id), { recursive: true });
  fs.writeFileSync(uploadPath(f), buf);
  fs.writeFileSync(path.join(UPLOADS, f.id, 'meta.json'), JSON.stringify(f));
  json(res, 200, f);
});
const INLINE = /^image\/(png|jpe?g|gif|webp|avif)$|^application\/pdf$/;
route('GET', '/api/files/:id/:name', (req, res, p) => {
  const f = readUpload(p.id);
  if (!f) return json(res, 404, { error: 'not found' });
  // Only safe types open in the browser; anything else (HTML, SVG…) downloads, so it can't run script here.
  const inline = INLINE.test(f.type);
  res.writeHead(200, { 'content-type': inline ? f.type : 'application/octet-stream', 'content-length': f.size, 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'cache-control': 'private, max-age=31536000, immutable',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}` });
  fs.createReadStream(uploadPath(f)).pipe(res);
});

// Restart the service once no bot is mid-run (a restart kills running bots, including one that asked for it).
// Needs a sudoers rule letting this user run `systemctl restart nimbus`.
let restartPending = false;
route('POST', '/api/admin/restart', (req, res) => {
  if (!restartPending) {
    restartPending = true;
    const tick = () => {
      const busy = q("SELECT COUNT(*) AS n FROM runs WHERE status IN ('running','queued')").get().n;
      if (busy) return setTimeout(tick, 3000);
      execFile('sudo', ['-n', '/usr/bin/systemctl', 'restart', 'nimbus'], (err) => { if (err) { restartPending = false; console.error('restart failed:', err.message); } });
    };
    setTimeout(tick, 1000);
  }
  json(res, 200, { ok: true, note: 'Nimbus restarts as soon as no bot is running.' });
});

// Bots
function cleanBot(b) {
  const out = {};
  for (const k of ['name', 'role', 'instructions', 'color', 'model', 'shape']) if (b[k] !== undefined) out[k] = String(b[k]);
  if (b.computer !== undefined) out.computer = b.computer ? 1 : 0;
  if (b.effort !== undefined) { if (!EFFORTS.includes(b.effort)) throw new Error('bad effort'); out.effort = b.effort; }
  for (const k of ['approval_rules', 'allow_rules']) if (b[k] !== undefined) out[k] = JSON.stringify((b[k] || []).map(String).filter(Boolean));
  return out;
}
function saveBot(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length) q(`UPDATE bots SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => fields[k]), id);
  const bot = parseBot(q('SELECT * FROM bots WHERE id=?').get(id));
  writeBotBrief(bot);
  broadcast('state_changed', {});
  return bot;
}
route('POST', '/api/bots', async (req, res) => {
  const b = await body(req);
  if (!b.name?.trim()) return json(res, 400, { error: 'name required' });
  const defaults = JSON.stringify(['Bash(git push*)', 'Bash(rm -rf*)', 'Bash(*gh pr merge*)', 'mcp__*send*', 'mcp__*delete*', 'mcp__*pay*', 'mcp__*create_event*']);
  const r = q('INSERT INTO bots (name, approval_rules) VALUES (?,?)').run(b.name.trim(), defaults);
  json(res, 200, saveBot(r.lastInsertRowid, cleanBot(b)));
});
route('PATCH', '/api/bots/:id', async (req, res, p) => json(res, 200, saveBot(Number(p.id), cleanBot(await body(req)))));
route('DELETE', '/api/bots/:id', (req, res, p) => {
  const had = q('SELECT computer FROM bots WHERE id=?').get(p.id)?.computer;
  if (had && computersOn()) agent(`/computers/${Number(p.id)}`, { method: 'DELETE' }).catch(() => {}); // its computer goes too
  q('DELETE FROM bots WHERE id=?').run(p.id);
  q('DELETE FROM room_members WHERE bot_id=?').run(p.id);
  q('DELETE FROM routines WHERE bot_id=?').run(p.id);
  broadcast('state_changed', {});
  json(res, 200, { ok: true });
});
// ---------- bot computers ----------
const viewerUrl = (port) => { const u = new URL(agentConfig().url); return `http://${u.hostname}:${port}/`; };
async function computerRoute(res, fn) {
  if (!computersOn()) return json(res, 400, { error: 'Bot computers aren’t set up. Add the computer VM in Server settings (see deploy/computer/README.md).' });
  try { const c = await fn(); json(res, 200, c.port ? { ...c, url: viewerUrl(c.port) } : c); }
  catch (e) { json(res, 502, { error: `Couldn’t reach the computer VM: ${e.message}` }); }
}
route('GET', '/api/bots/:id/computer', (req, res, p) => computerRoute(res, () => agent(`/computers/${Number(p.id)}`)));
route('POST', '/api/bots/:id/computer', (req, res, p) => computerRoute(res, () => agent(`/computers/${Number(p.id)}`, { method: 'POST' })));
route('DELETE', '/api/bots/:id/computer', (req, res, p) => computerRoute(res, async () => {
  await agent(`/computers/${Number(p.id)}`, { method: 'DELETE' });
  saveBot(Number(p.id), { computer: 0 });
  return { ok: true };
}));

// Status of every bot computer plus the VM's memory, for the app (cached briefly; docker stats is slow).
let compCache = null;
route('GET', '/api/computers', async (req, res) => {
  if (!computersOn()) return json(res, 200, { on: false });
  if (compCache && Date.now() - compCache.at < 10_000) return json(res, 200, compCache.data);
  try { compCache = { at: Date.now(), data: { on: true, ...(await agent('/computers')), sleepAfterMin: SLEEP_AFTER_MIN } }; json(res, 200, compCache.data); }
  catch (e) { json(res, 200, { on: true, error: e.message }); }
});
// Browse and download files from a bot's home folder on its computer (~/Downloads, ~/work, …).
route('GET', '/api/bots/:id/files', (req, res, p, url) => computerRoute(res, () => agent(`/computers/${Number(p.id)}/files?dir=${encodeURIComponent(url.searchParams.get('dir') || '')}`)));
route('GET', '/api/bots/:id/file', async (req, res, p, url) => {
  if (!computersOn()) return json(res, 400, { error: 'Bot computers aren’t set up' });
  const rel = String(url.searchParams.get('path') || '');
  try {
    const { url: base, token } = agentConfig();
    const r = await fetch(`${base}/computers/${Number(p.id)}/file?path=${encodeURIComponent(rel)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return json(res, r.status, { error: 'File not found' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff',
      ...(r.headers.get('content-length') ? { 'content-length': r.headers.get('content-length') } : {}),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rel.split('/').pop() || 'file')}` });
    for await (const chunk of r.body) res.write(chunk);
    res.end();
  } catch (e) { if (!res.headersSent) json(res, 502, { error: e.message }); else res.destroy(); }
});
// Rebuild the computer image with the latest Claude Code and Chromium, then recreate the computers
// (home folders, browser profiles and sign-ins are kept). Runs on the VM; poll GET for progress.
route('POST', '/api/computers/update', (req, res) => computerRoute(res, () => agent('/update', { method: 'POST', body: JSON.stringify({
  dockerfile: fs.readFileSync(path.join(HERE, 'deploy/computer/Dockerfile'), 'utf8'),
  hook: fs.readFileSync(path.join(HERE, 'hooks/approval-hook.js'), 'utf8') }) })));
route('GET', '/api/computers/update', (req, res) => computerRoute(res, () => agent('/update')));

// Auto-sleep: stop a computer that hasn't run a task or been watched for a while. Its next task (or
// opening its screen) starts it again; files, the browser profile and sign-ins live on its volume.
const SLEEP_AFTER_MIN = Number(process.env.NIMBUS_COMPUTER_SLEEP_MIN ?? 120);
const deskSeen = new Map(); // botId -> last time someone was watching its screen
setInterval(async () => {
  if (!SLEEP_AFTER_MIN || !computersOn()) return;
  try {
    const { computers } = await agent('/computers');
    for (const c of computers.filter((x) => x.running)) {
      const last = q("SELECT MAX(COALESCE(ended_at, started_at, unixepoch())) AS t FROM runs WHERE bot_id=?").get(c.bot).t || 0;
      const busy = q("SELECT COUNT(*) AS n FROM runs WHERE bot_id=? AND status IN ('queued','running')").get(c.bot).n;
      const idleMs = Date.now() - Math.max(last * 1000, deskSeen.get(c.bot) || 0);
      if (!busy && idleMs > SLEEP_AFTER_MIN * 60_000) {
        await agent(`/computers/${c.bot}/stop`, { method: 'POST' });
        deskCache.delete(c.bot); compCache = null;
        console.log(`Computer for bot ${c.bot} went to sleep after ${Math.round(idleMs / 60000)} min idle`);
      }
    }
  } catch {}
}, 5 * 60_000).unref();

route('GET', '/api/bots/:id/memory', (req, res, p) => json(res, 200, { text: fs.readFileSync(path.join(botDir(p.id), 'MEMORY.md'), 'utf8') }));
route('PUT', '/api/bots/:id/memory', async (req, res, p) => {
  fs.writeFileSync(path.join(botDir(p.id), 'MEMORY.md'), String((await body(req)).text || ''));
  broadcast('state_changed', {});
  json(res, 200, { ok: true });
});
route('POST', '/api/bots/:id/reset', (req, res, p) => {
  q('DELETE FROM sessions WHERE bot_id=?').run(p.id);
  addMessage('bot:' + p.id, 'system', 'note', 'Started a fresh conversation. Memory is kept.');
  json(res, 200, { ok: true });
});

// Routines
// ---------- marketplace ----------
// Connectors on the user's claude.ai account reach every bot through Claude Code's login.
// `claude mcp list` health-checks each one, so it's slow: cache it and refresh in the background.
let connCache = { at: 0, list: [], loading: null };
function loadConnectors() {
  if (connCache.loading) return connCache.loading;
  connCache.loading = new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['mcp', 'list'], { timeout: 90_000, cwd: DATA_DIR }, (err, out = '') => {
      const list = [];
      for (const line of String(out).split('\n')) {
        const m = line.match(/^claude\.ai (.+?): .* - (.+)$/);
        if (m) list.push({ name: m[1].trim(), status: /connected/i.test(m[2]) && !/not|fail/i.test(m[2]) ? 'connected' : m[2].replace(/^[^A-Za-z]+/, '').trim() });
      }
      if (!err || list.length) connCache = { at: Date.now(), list, loading: null };
      else connCache.loading = null;
      resolve(connCache.list);
    });
  });
  return connCache.loading;
}
loadConnectors();
async function claudeConnectors(fresh) {
  if (fresh || !connCache.at) await loadConnectors();
  else if (Date.now() - connCache.at > 5 * 60_000) loadConnectors();
  return connCache.list;
}
const sameName = (a, b) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');
route('GET', '/api/marketplace', async (req, res, _p, url) => {
  const installed = new Set(q('SELECT id FROM plugins').all().map((r) => r.id));
  const added = new Set(q("SELECT template FROM bots WHERE template != ''").all().map((r) => r.template));
  const connectors = await claudeConnectors(url.searchParams.get('fresh') === '1');
  json(res, 200, {
    templates: TEMPLATES.map((t) => ({ ...t, added: added.has(t.id) })),
    plugins: PLUGINS.map((p) => {
      const c = p.kind === 'claude' && connectors.find((x) => sameName(x.name, p.name));
      return { ...publicPlugin(p), installed: p.kind === 'claude' ? c?.status === 'connected' : installed.has(p.id), connector: c || null };
    }),
    connectors
  });
});
route('POST', '/api/templates/:id/add', (req, res, p) => {
  const t = TEMPLATES.find((x) => x.id === p.id);
  if (!t) return json(res, 404, { error: 'not found' });
  const r = q('INSERT INTO bots (name, role, instructions, color, effort, shape, template, approval_rules) VALUES (?,?,?,?,?,?,?,?)')
    .run(t.name, t.role, t.instructions, t.color, t.effort, t.shape, t.id, JSON.stringify(t.approval_rules));
  const id = Number(r.lastInsertRowid);
  for (const rt of t.routines || []) q('INSERT INTO routines (bot_id, cron, prompt) VALUES (?,?,?)').run(id, rt.cron, rt.prompt);
  const installed = new Set(q('SELECT id FROM plugins').all().map((x) => x.id));
  for (const pid of t.plugins || []) {
    const pl = PLUGINS.find((x) => x.id === pid);
    if (pl && (pl.kind === 'claude' || installed.has(pid))) q('INSERT OR IGNORE INTO bot_plugins VALUES (?,?)').run(id, pid);
  }
  json(res, 200, saveBot(id, {}));
});
route('POST', '/api/plugins/:id', async (req, res, p) => {
  const pl = PLUGINS.find((x) => x.id === p.id);
  if (!pl || pl.kind !== 'mcp') return json(res, 404, { error: 'not found' });
  const { secrets = {} } = await body(req);
  const clean = {};
  for (const f of pl.fields || []) {
    const v = String(secrets[f.key] || '').trim();
    if (!v) return json(res, 400, { error: `${f.label} is required` });
    clean[f.key] = v;
  }
  q('INSERT INTO plugins (id, secrets) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET secrets=excluded.secrets').run(pl.id, JSON.stringify(clean));
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});
route('DELETE', '/api/plugins/:id', (req, res, p) => {
  q('DELETE FROM plugins WHERE id=?').run(p.id);
  q('DELETE FROM bot_plugins WHERE plugin_id=?').run(p.id);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});
route('PUT', '/api/bots/:id/plugins', async (req, res, p) => {
  const ids = ((await body(req)).plugins || []).map(String).filter((id) => PLUGINS.some((x) => x.id === id));
  q('DELETE FROM bot_plugins WHERE bot_id=?').run(p.id);
  for (const id of ids) q('INSERT OR IGNORE INTO bot_plugins VALUES (?,?)').run(p.id, id);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});

route('POST', '/api/routines', async (req, res) => {
  const r = await body(req);
  if (!isValidCron(r.cron)) return json(res, 400, { error: 'Schedule must be a 5-part cron like "0 9 * * 1-5"' });
  q('INSERT INTO routines (bot_id, cron, prompt, quiet) VALUES (?,?,?,?)').run(r.bot_id, r.cron.trim(), r.prompt || '', r.quiet ? 1 : 0);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});
route('PATCH', '/api/routines/:id', async (req, res, p) => {
  const r = await body(req);
  if (r.cron !== undefined && !isValidCron(r.cron)) return json(res, 400, { error: 'Invalid schedule' });
  const cur = q('SELECT * FROM routines WHERE id=?').get(p.id);
  q('UPDATE routines SET cron=?, prompt=?, enabled=?, quiet=? WHERE id=?').run(r.cron ?? cur.cron, r.prompt ?? cur.prompt, r.enabled ?? cur.enabled, r.quiet === undefined ? cur.quiet : r.quiet ? 1 : 0, p.id);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});
route('DELETE', '/api/routines/:id', (req, res, p) => { q('DELETE FROM routines WHERE id=?').run(p.id); broadcast('state_changed', {}); json(res, 200, { ok: true }); });
route('POST', '/api/routines/:id/run', (req, res, p) => {
  const r = q('SELECT * FROM routines WHERE id=?').get(p.id);
  runBot({ botId: r.bot_id, thread: 'bot:' + r.bot_id, prompt: r.prompt, source: 'schedule', quiet: !!r.quiet });
  json(res, 200, { ok: true });
});

// Rooms (group chats)
function saveRoom(id, r) {
  const cur = q('SELECT * FROM rooms WHERE id=?').get(id);
  q('UPDATE rooms SET name=?, goal=?, lead_bot_id=?, bots_can_talk=? WHERE id=?').run(
    (r.name ?? cur.name).replace(/^#\s*/, ''), r.goal ?? cur.goal, r.lead_bot_id ?? cur.lead_bot_id, r.bots_can_talk === undefined ? cur.bots_can_talk : r.bots_can_talk ? 1 : 0, id);
  if (Array.isArray(r.members)) {
    q('DELETE FROM room_members WHERE room_id=?').run(id);
    for (const b of r.members) q('INSERT OR IGNORE INTO room_members (room_id, bot_id) VALUES (?,?)').run(id, b);
  }
  broadcast('state_changed', {});
  return q('SELECT * FROM rooms WHERE id=?').get(id);
}
route('POST', '/api/rooms', async (req, res) => {
  const r = await body(req);
  if (!r.name?.trim()) return json(res, 400, { error: 'name required' });
  const ins = q('INSERT INTO rooms (name) VALUES (?)').run(r.name.trim());
  json(res, 200, saveRoom(ins.lastInsertRowid, r));
});
route('PATCH', '/api/rooms/:id', async (req, res, p) => json(res, 200, saveRoom(Number(p.id), await body(req))));
route('DELETE', '/api/rooms/:id', (req, res, p) => {
  q('DELETE FROM rooms WHERE id=?').run(p.id); q('DELETE FROM room_members WHERE room_id=?').run(p.id);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});

// Runs
route('POST', '/api/runs/:id/stop', (req, res, p) => { stopRun(p.id); json(res, 200, { ok: true }); });

// Approvals (user side)
route('POST', '/api/approvals/:id', async (req, res, p) => {
  const { decision, note, remember } = await body(req);
  const a = q('SELECT * FROM approvals WHERE id=?').get(p.id);
  if (!a || a.status !== 'pending') return json(res, 409, { error: 'Already decided' });
  const status = decision === 'approve' ? 'approved' : 'rejected';
  q('UPDATE approvals SET status=?, note=?, decided_at=unixepoch() WHERE id=?').run(status, note || null, a.id);
  if (remember && status === 'approved') {
    const bot = parseBot(q('SELECT * FROM bots WHERE id=?').get(a.bot_id));
    const input = JSON.parse(a.input || '{}');
    const rule = rememberRule(a.tool, input, remember);
    if (!bot.allow_rules.includes(rule)) saveBot(bot.id, { allow_rules: JSON.stringify([...bot.allow_rules, rule]) });
  }
  const msg = q("SELECT * FROM messages WHERE kind='approval' AND run_id=? AND body LIKE ?").get(a.run_id, `%"approvalId":${a.id},%`);
  if (msg) updateMessage(msg.id, { ...JSON.parse(msg.body), status, note: note || null });
  markTraceWaiting(a.run_id, a.tool, false);
  notifyApproval(a.id);
  broadcast('approvals_changed', {});
  json(res, 200, { ok: true });
});

// ---------- server settings (bot computers, Proxmox) ----------
// Secrets are write-only: the app sees whether one is saved, never its value.
const SETTINGS = [
  { key: 'agent_url', env: 'NIMBUS_AGENT_URL' }, { key: 'agent_token', env: 'NIMBUS_AGENT_TOKEN', secret: true }, { key: 'callback_url', env: 'NIMBUS_CALLBACK_URL' },
  { key: 'pve_host' }, { key: 'pve_token_id' }, { key: 'pve_token_secret', secret: true },
  { key: 'backup_target' }
];
route('GET', '/api/settings', (req, res) => {
  const out = {};
  for (const s of SETTINGS) { const v = getSetting(s.key, s.env); out[s.key] = s.secret ? (v ? '__saved__' : '') : v; }
  json(res, 200, out);
});
route('PUT', '/api/settings', async (req, res) => {
  const b = await body(req);
  for (const s of SETTINGS) {
    if (b[s.key] === undefined || (s.secret && b[s.key] === '__saved__')) continue;
    const v = String(b[s.key]).trim();
    if (s.key === 'backup_target' && v && !/^[\w.-]+@[\w.-]+:\/[^\s]*$/.test(v)) return json(res, 400, { error: 'Backup target should look like user@host:/path' });
    if (/_url$/.test(s.key) && v && !/^https?:\/\/[^\s]+$/.test(v)) return json(res, 400, { error: `${s.key.replace('_', ' ')} must start with http:// or https://` });
    setSetting(s.key, v);
  }
  pveCache = null;
  broadcast('state_changed', {});
  json(res, 200, { ok: true, computers: computersOn(), proxmox: !!pveConfig() });
});
route('POST', '/api/settings/test-agent', (req, res) => computerRoute(res, () => agent('/health')));

function pveConfig() {
  const host = getSetting('pve_host'), id = getSetting('pve_token_id'), secret = getSetting('pve_token_secret');
  return host && id && secret ? { host, id, secret } : null;
}
// Proxmox uses a self-signed certificate by default, so certificate checks are off for this LAN call only.
function pveGet(cfg, p) {
  return new Promise((resolve, reject) => {
    const r = https.get({ host: cfg.host, port: 8006, path: '/api2/json' + p, rejectUnauthorized: false, timeout: 5000,
      headers: { authorization: `PVEAPIToken=${cfg.id}=${cfg.secret}` } }, (resp) => {
      let s = ''; resp.on('data', (c) => (s += c));
      resp.on('end', () => resp.statusCode === 200 ? resolve(JSON.parse(s).data) : reject(new Error(`Proxmox said ${resp.statusCode}`)));
    });
    r.on('timeout', () => r.destroy(new Error('Proxmox didn’t answer')));
    r.on('error', reject);
  });
}
let pveCache = null; // { at, data }
route('GET', '/api/proxmox', async (req, res) => {
  const cfg = pveConfig();
  if (!cfg) return json(res, 200, { configured: false });
  if (pveCache && Date.now() - pveCache.at < 15000) return json(res, 200, pveCache.data);
  try {
    const [nodes, guests] = await Promise.all([pveGet(cfg, '/nodes'), pveGet(cfg, '/cluster/resources?type=vm')]);
    const data = { configured: true,
      nodes: nodes.map((n) => ({ name: n.node, status: n.status, cpu: n.cpu, mem: n.mem, maxmem: n.maxmem, disk: n.disk, maxdisk: n.maxdisk, uptime: n.uptime })),
      guests: guests.filter((g) => !g.template).map((g) => ({ id: g.vmid, name: g.name, type: g.type, status: g.status, node: g.node })).sort((a, b) => a.id - b.id) };
    pveCache = { at: Date.now(), data };
    json(res, 200, data);
  } catch (e) { json(res, 200, { configured: true, error: e.message }); }
});

// ---------- Claude plan usage (planusage.js) ----------
route('GET', '/api/plan-usage', async (req, res) => json(res, 200, await getPlanUsage()));

// ---------- read aloud (Piper, local text-to-speech) ----------
// Turns a bot reply into speech on this server; nothing leaves the network.
const PIPER_BIN = process.env.NIMBUS_PIPER_BIN || path.join(os.homedir(), 'opt/piper/piper');
const PIPER_VOICE = process.env.NIMBUS_PIPER_VOICE || path.join(os.homedir(), 'opt/piper-voices/en_US-lessac-medium.onnx');
// Markdown and links read badly, so speak plain text.
const speakable = (t) => String(t || '').replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, 'a link').replace(/[*_#>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
route('GET', '/api/speak', (req, res) => json(res, 200, { available: fs.existsSync(PIPER_BIN) && fs.existsSync(PIPER_VOICE) }));
route('POST', '/api/speak', async (req, res) => {
  if (!fs.existsSync(PIPER_BIN) || !fs.existsSync(PIPER_VOICE)) return json(res, 503, { error: 'Read-aloud isn’t installed on the server' });
  const { messageId, text } = await body(req);
  const src = messageId ? q('SELECT body FROM messages WHERE id=?').get(Number(messageId))?.body : text;
  const say = speakable(src);
  if (!say) return json(res, 400, { error: 'Nothing to read' });
  const p = spawn(PIPER_BIN, ['--model', PIPER_VOICE, '--output_file', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const chunks = [];
  p.stdout.on('data', (c) => chunks.push(c));
  p.on('error', (e) => { if (!res.headersSent) json(res, 500, { error: e.message }); });
  p.on('close', (code) => {
    if (res.headersSent) return;
    if (code !== 0 || !chunks.length) return json(res, 500, { error: 'Speech failed' });
    const wav = Buffer.concat(chunks);
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' });
    res.end(wav);
  });
  p.stdin.end(say);
});

// ---------- backups (bin/backup.mjs) ----------
// Nightly at 03:15 local time, plus "Back up now" in Server settings. The last result is kept in settings.
let backupRunning = false;
function runBackup() {
  if (backupRunning) return Promise.resolve(JSON.parse(getSetting('backup_last') || '{}'));
  backupRunning = true;
  return new Promise((resolve) => execFile(process.execPath, ['--no-warnings', path.join(HERE, 'bin/backup.mjs')], { timeout: 30 * 60_000 }, (err, out) => {
    backupRunning = false;
    let r; try { r = JSON.parse(String(out).trim().split('\n').pop()); } catch { r = { ok: false, error: err?.message || 'backup failed', at: Date.now() }; }
    setSetting('backup_last', JSON.stringify(r));
    if (!r.ok) addMessage('bot:3', 'system', 'note', `⚠ Nightly backup failed: ${r.error}`);
    resolve(r);
  }));
}
setInterval(() => {
  const d = new Date();
  if (d.getHours() === 3 && d.getMinutes() === 15) runBackup();
}, 60_000).unref();
route('GET', '/api/backup', (req, res) => json(res, 200, { last: JSON.parse(getSetting('backup_last') || 'null'), running: backupRunning }));
route('POST', '/api/backup', async (req, res) => json(res, 200, await runBackup()));

// ---------- search, activity log, usage by bot ----------
route('GET', '/api/search', (req, res, _p, url) => {
  const term = String(url.searchParams.get('q') || '').trim();
  if (term.length < 2) return json(res, 200, { results: [] });
  const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = q(`SELECT id, thread, author, body, created_at FROM messages WHERE kind IN ('text','quiet','note') AND body LIKE ? ESCAPE '\\'
    ORDER BY id DESC LIMIT 40`).all(like);
  const low = term.toLowerCase();
  json(res, 200, { results: rows.map((m) => {
    const i = m.body.toLowerCase().indexOf(low), start = Math.max(0, i - 50);
    return { id: m.id, thread: m.thread, author: m.author, at: m.created_at,
      snippet: (start ? '…' : '') + m.body.slice(start, start + 160).replace(/\s+/g, ' ') + (start + 160 < m.body.length ? '…' : '') };
  }) });
});
route('GET', '/api/activity', (req, res, _p, url) => {
  const days = Math.min(90, Number(url.searchParams.get('days') || 7));
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const runs = q(`SELECT id, bot_id, thread, status, started_at, ended_at, cost_usd, effort, parent_run, substr(prompt, 1, 160) AS prompt
    FROM runs WHERE started_at >= ? ORDER BY id DESC LIMIT 400`).all(since);
  const approvals = q(`SELECT id, run_id, bot_id, tool, status, note, created_at, decided_at, substr(input, 1, 300) AS input
    FROM approvals WHERE created_at >= ? ORDER BY id DESC LIMIT 400`).all(since);
  json(res, 200, { runs, approvals });
});

// ---------- voice dictation (whisper.cpp) ----------
// Nimbus runs whisper.cpp's server as a child process on localhost only. The browser records 16 kHz
// WAV, so no audio conversion is needed here. Recordings are never written to disk.
const WHISPER_BIN = process.env.NIMBUS_WHISPER_BIN || path.join(os.homedir(), 'opt/whisper.cpp/build/bin/whisper-server');
const WHISPER_MODEL = process.env.NIMBUS_WHISPER_MODEL || path.join(os.homedir(), 'opt/whisper-models/ggml-small.en.bin');
const WHISPER_PORT = Number(process.env.NIMBUS_WHISPER_PORT || 8178);
let whisperProc = null, whisperFails = 0;
function startWhisper() {
  if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) return;
  whisperProc = spawn(WHISPER_BIN, ['-m', WHISPER_MODEL, '--host', '127.0.0.1', '--port', String(WHISPER_PORT), '-t', String(Math.max(2, os.cpus().length - 2))], { stdio: 'ignore' });
  whisperProc.on('exit', () => {
    whisperProc = null;
    if (++whisperFails <= 5) setTimeout(startWhisper, 5000 * whisperFails); // crashed: retry with backoff
  });
  setTimeout(() => { whisperFails = 0; }, 60_000).unref();
}
startWhisper();
process.on('exit', () => whisperProc?.kill());
route('GET', '/api/transcribe', (req, res) => json(res, 200, { available: !!whisperProc }));
route('POST', '/api/transcribe', async (req, res) => {
  if (!whisperProc) return json(res, 503, { error: 'Dictation isn’t running on the server' });
  const { audio } = await body(req, 16e6); // ~5 minutes of 16 kHz mono WAV, base64
  const wav = Buffer.from(String(audio || ''), 'base64');
  if (wav.length < 1000 || wav.toString('ascii', 0, 4) !== 'RIFF') return json(res, 400, { error: 'Expected a WAV recording' });
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  try {
    const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
    // Whisper marks silence and noise like "[BLANK_AUDIO]" or "(wind blowing)"; drop those.
    const text = String(d.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    json(res, 200, { text });
  } catch (e) { json(res, 502, { error: 'Transcription failed: ' + e.message }); }
});

// Approvals (hook side: localhost, or the computer VM)
// Bots run here (localhost) or in a container on the computer VM, whose hook calls come from the VM's address.
function hookAuth(req) {
  const t = String(req.headers['x-nimbus-hook'] || '');
  if (t.length !== HOOK_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(HOOK_TOKEN))) return false;
  const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (['127.0.0.1', '::1'].includes(from)) return true;
  try { return computersOn() && from === new URL(agentConfig().url).hostname; } catch { return false; }
}
route('POST', '/api/hook/pretool', async (req, res) => {
  if (!hookAuth(req)) return json(res, 403, { error: 'forbidden' });
  const { runId, tool, input } = await body(req);
  const run = q('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return json(res, 200, { decision: 'allow' });
  const bot = parseBot(q('SELECT * FROM bots WHERE id=?').get(run.bot_id));
  const gated = bot.approval_rules.some((r) => ruleMatches(r, tool, input)) && !bot.allow_rules.some((r) => ruleMatches(r, tool, input))
    && !(bot.allow_rules.includes('@self-email') && isSelfEmail(tool, input));
  if (!gated) return json(res, 200, { decision: 'allow' });
  const ins = q('INSERT INTO approvals (run_id, bot_id, thread, tool, input) VALUES (?,?,?,?,?)').run(run.id, bot.id, run.thread, tool, redact(JSON.stringify(input || {})));
  const approvalId = Number(ins.lastInsertRowid);
  const pattern = tool === 'Bash' ? commandPrefix(String(input?.command || '')).trim() + ' …' : null;
  addMessage(run.thread, bot.id, 'approval', { approvalId, tool, input, status: 'pending', pattern }, run.id);
  markTraceWaiting(run.id, tool, true);
  broadcast('approvals_changed', {});
  json(res, 200, { decision: 'ask', approvalId });
});
// Bot-to-bot messages (bin/ask-bot.mjs). The asking bot's run id gives who is asking and the
// chain of bots already waiting, so a bot can't message one that is waiting on it (that would deadlock).
// Answers wait at most 4 minutes: Node's fetch gives up on a response with no headers after 5, so
// longer jobs return a run id to collect with --result.
const MAX_ASK_DEPTH = 4;
function askChain(runId) {
  const bots = [];
  for (let id = runId, n = 0; id && n < 20; n++) {
    const r = q('SELECT bot_id, parent_run FROM runs WHERE id=?').get(id);
    if (!r) break;
    bots.push(r.bot_id); id = r.parent_run;
  }
  return bots;
}
function findBot(ref) {
  const all = q('SELECT * FROM bots').all();
  const s = String(ref || '').trim().replace(/^@/, '');
  const byId = s.match(/^#?(\d+)$/);
  if (byId) return all.find((b) => b.id === Number(byId[1]));
  const low = s.toLowerCase();
  const exact = all.filter((b) => b.name.toLowerCase() === low);
  if (exact.length === 1) return exact[0];
  const part = all.filter((b) => b.name.toLowerCase().includes(low));
  return part.length === 1 ? part[0] : null;
}
async function askResult(runId, waitMs) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const r = q('SELECT status FROM runs WHERE id=?').get(runId);
    if (!r) return { error: 'No such run' };
    if (!['queued', 'running'].includes(r.status)) {
      const m = q("SELECT body, kind FROM messages WHERE run_id=? AND kind IN ('text','error') ORDER BY id DESC LIMIT 1").get(runId);
      return { status: r.status, reply: m?.body || '(no reply)', error: m?.kind === 'error' || undefined };
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { status: 'running', runId, note: `Still working. Fetch the answer later with --result ${runId}.` };
}
route('POST', '/api/hook/ask', async (req, res) => {
  if (!hookAuth(req)) return json(res, 403, { error: 'forbidden' });
  const { fromRun, to, text, wait = true } = await body(req);
  const from = q('SELECT b.* FROM runs r JOIN bots b ON b.id = r.bot_id WHERE r.id=?').get(Number(fromRun));
  if (!from) return json(res, 400, { error: 'Unknown asking run' });
  const target = findBot(to);
  if (!target) return json(res, 404, { error: `No single bot matches "${to}". Bots: ${q('SELECT id, name FROM bots ORDER BY id').all().map((b) => `${b.name} (#${b.id})`).join(', ')}` });
  if (target.id === from.id) return json(res, 400, { error: 'That is you.' });
  if (!String(text || '').trim()) return json(res, 400, { error: 'Empty message' });
  const chain = askChain(Number(fromRun));
  if (chain.includes(target.id)) return json(res, 409, { error: `${target.name} is waiting on your answer, so it can't take a message now. Put what you want to tell it in your reply.` });
  if (chain.length > MAX_ASK_DEPTH) return json(res, 429, { error: 'Too many bots are already waiting on each other. Answer with what you have.' });
  const thread = 'bot:' + target.id;
  addMessage(thread, 'system', 'note', `📨 ${from.name}: ${String(text).trim()}`);
  const runId = runBot({ botId: target.id, thread, source: from.name, parentRun: Number(fromRun), depth: chain.length,
    prompt: `Message from ${from.name}, another Nimbus bot (not the user):\n\n${String(text).trim()}\n\n${wait ? `Your reply is sent back to ${from.name}, so answer what it needs.` : `${from.name} isn't waiting for a reply; act on this if it's in your area.`}` });
  if (!wait) return json(res, 200, { queued: true, runId, to: target.name });
  json(res, 200, { to: target.name, ...(await askResult(runId, 4 * 60_000)) });
});
route('GET', '/api/hook/ask/:runId', async (req, res, p) => {
  if (!hookAuth(req)) return json(res, 403, { error: 'forbidden' });
  json(res, 200, await askResult(Number(p.runId), 4 * 60_000));
});
route('GET', '/api/hook/approval/:id', (req, res, p) => {
  if (!hookAuth(req)) return json(res, 403, { error: 'forbidden' });
  const id = Number(p.id);
  const reply = () => { const a = q('SELECT status, note FROM approvals WHERE id=?').get(id); json(res, 200, a || { status: 'expired' }); };
  const a = q('SELECT status FROM approvals WHERE id=?').get(id);
  if (!a || a.status !== 'pending') return reply();
  const timer = setTimeout(done, 50000);
  function done() { clearTimeout(timer); waiters.get(id)?.delete(done); if (!res.writableEnded) reply(); }
  if (!waiters.has(id)) waiters.set(id, new Set());
  waiters.get(id).add(done);
  req.on('close', () => waiters.get(id)?.delete(done));
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp' };

// ---------- login ----------
// The app is meant to be reachable from the internet, so some login method is required:
// email + password accounts (limited to NIMBUS_ALLOWED_EMAILS), or a single shared NIMBUS_PASSWORD.
const ACCOUNTS = ALLOWED_EMAILS.length > 0;
const AUTH_ON = !!(PASSWORD || ACCOUNTS);
if (!AUTH_ON && process.env.NIMBUS_ALLOW_NO_PASSWORD !== '1') {
  console.error('Set up a login before starting Nimbus (anyone who can reach this server could otherwise control your bots): NIMBUS_ALLOWED_EMAILS (for email sign-up), or NIMBUS_PASSWORD. See README.');
  process.exit(1);
}
db.exec('CREATE TABLE IF NOT EXISTS auth_sessions (token TEXT PRIMARY KEY, created_at INTEGER DEFAULT (unixepoch()))');
if (!q('PRAGMA table_info(auth_sessions)').all().some((c) => c.name === 'email')) db.exec("ALTER TABLE auth_sessions ADD COLUMN email TEXT DEFAULT ''");
db.exec('CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()))');
const SESSION_DAYS = 90;
const hashPassword = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const failures = new Map(); // ip -> { n, until }
function clientIp(req) {
  const direct = req.socket.remoteAddress || '';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(direct);
  return local && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : direct;
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}
function cookieToken(req) {
  const t = cookie(req, 'nimbus_session');
  return t && /^[a-f0-9]{64}$/.test(t) ? t : null;
}
function loggedIn(req) {
  if (!AUTH_ON) return true;
  const t = cookieToken(req);
  const row = t && q('SELECT email FROM auth_sessions WHERE token=? AND created_at > unixepoch() - ?').get(t, SESSION_DAYS * 86400);
  if (row) req.user = { email: row.email };
  return !!row;
}
function isHttps(req) {
  return !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || process.env.NIMBUS_SECURE_COOKIE === '1';
}
function newSessionCookie(req, email = '') {
  const token = crypto.randomBytes(32).toString('hex');
  q('INSERT INTO auth_sessions (token, email) VALUES (?,?)').run(token, email);
  return `nimbus_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`;
}
const LOGIN_PAGE = fs.readFileSync(path.join(PUBLIC, 'login.html'));

route('POST', '/api/login', async (req, res) => {
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.n >= 8 && f.until > Date.now()) return json(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
  const { email: rawEmail, password } = await body(req);
  const email = String(rawEmail || '').trim().toLowerCase();
  let ok = false;
  if (email) {
    const u = q('SELECT * FROM users WHERE email=?').get(email);
    // Hash even for unknown emails so response time doesn't reveal which accounts exist.
    const got = Buffer.from(hashPassword(password || '', u?.salt || 'x'), 'hex');
    ok = !!u && ALLOWED_EMAILS.includes(email) && crypto.timingSafeEqual(got, Buffer.from(u.pw_hash, 'hex'));
  } else if (PASSWORD && password) {
    ok = crypto.timingSafeEqual(hash(password), hash(PASSWORD));
  }
  if (!ok) {
    const cur = f && f.until > Date.now() ? f : { n: 0 };
    failures.set(ip, { n: cur.n + 1, until: Date.now() + 15 * 60_000 });
    await new Promise((r) => setTimeout(r, 600));
    return json(res, 401, { error: email ? 'Wrong email or password' : 'Wrong password' });
  }
  failures.delete(ip);
  const acct = email && q('SELECT totp_enabled FROM users WHERE email=?').get(email);
  if (acct?.totp_enabled) {
    // Password was right; the session is only issued after the authenticator code.
    const ticket = crypto.randomBytes(24).toString('hex');
    mfaTickets.set(ticket, { email, until: Date.now() + 5 * 60_000, tries: 0 });
    return json(res, 200, { mfa: true, ticket });
  }
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': newSessionCookie(req, email) });
  res.end('{"ok":true}');
});
route('GET', '/api/auth-methods', (req, res) => json(res, 200, { password: !!PASSWORD, accounts: ACCOUNTS }));
route('GET', '/api/https-port', (req, res) => json(res, 200, { port: HTTPS_PORT }));

// Email sign-up. Nimbus can't send email to verify an address, so only emails on the
// NIMBUS_ALLOWED_EMAILS list can make an account, and each email can sign up once.
route('POST', '/api/signup', async (req, res) => {
  if (!ACCOUNTS) return json(res, 404, { error: 'Sign-up is not enabled' });
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.n >= 8 && f.until > Date.now()) return json(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
  const { email: rawEmail, password } = await body(req);
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email' });
  if (String(password || '').length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
  if (!ALLOWED_EMAILS.includes(email)) {
    const cur = f && f.until > Date.now() ? f : { n: 0 };
    failures.set(ip, { n: cur.n + 1, until: Date.now() + 15 * 60_000 });
    return json(res, 403, { error: "This email isn't allowed to use this Nimbus. Ask the owner to add it to NIMBUS_ALLOWED_EMAILS." });
  }
  if (q('SELECT 1 FROM users WHERE email=?').get(email)) return json(res, 409, { error: 'That email already has an account. Sign in instead.' });
  const salt = crypto.randomBytes(16).toString('hex');
  q('INSERT INTO users (email, salt, pw_hash) VALUES (?,?,?)').run(email, salt, hashPassword(password, salt));
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': newSessionCookie(req, email) });
  res.end('{"ok":true}');
});

// ---------- two-factor (authenticator app codes, RFC 6238 TOTP) ----------
for (const [col, def] of [['totp_secret', "''"], ['totp_enabled', '0'], ['recovery', "'[]'"]]) {
  if (!q('PRAGMA table_info(users)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def === '0' ? 'INTEGER' : 'TEXT'} DEFAULT ${def}`);
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function unbase32(str) {
  let bits = '';
  for (const ch of str.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// Accepts the current 30-second code or its neighbours, to allow for clock drift.
function checkTotp(secret, code) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(totp(secret, now + d)), Buffer.from(code)));
}
// A one-time recovery code is consumed when used.
function useRecoveryCode(user, code) {
  const h = hash(String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')).toString('hex');
  const list = JSON.parse(user.recovery || '[]');
  if (!list.includes(h)) return false;
  q('UPDATE users SET recovery=? WHERE email=?').run(JSON.stringify(list.filter((x) => x !== h)), user.email);
  return true;
}
const mfaTickets = new Map(); // ticket -> { email, until, tries }
function currentUser(req) { return req.user?.email ? q('SELECT * FROM users WHERE email=?').get(req.user.email) : null; }

route('POST', '/api/login/mfa', async (req, res) => {
  const { ticket, code } = await body(req);
  const t = mfaTickets.get(String(ticket || ''));
  if (!t || t.until < Date.now()) { mfaTickets.delete(ticket); return json(res, 401, { error: 'Sign-in expired. Start again.', restart: true }); }
  const user = q('SELECT * FROM users WHERE email=?').get(t.email);
  const ok = user && (checkTotp(user.totp_secret, code) || useRecoveryCode(user, code));
  if (!ok) {
    if (++t.tries >= 5) { mfaTickets.delete(ticket); return json(res, 401, { error: 'Too many wrong codes. Start again.', restart: true }); }
    await new Promise((r) => setTimeout(r, 600));
    return json(res, 401, { error: 'Wrong code' });
  }
  mfaTickets.delete(ticket);
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': newSessionCookie(req, t.email) });
  res.end('{"ok":true}');
});
route('GET', '/api/mfa', (req, res) => {
  const u = currentUser(req);
  json(res, 200, { available: !!u, enabled: !!u?.totp_enabled, recoveryLeft: u ? JSON.parse(u.recovery || '[]').length : 0 });
});
route('POST', '/api/mfa/setup', (req, res) => {
  const u = currentUser(req);
  if (!u) return json(res, 400, { error: 'Two-factor is for email + password accounts.' });
  if (u.totp_enabled) return json(res, 400, { error: 'Two-factor is already on' });
  const secret = base32(crypto.randomBytes(20));
  q('UPDATE users SET totp_secret=? WHERE email=?').run(secret, u.email);
  const uri = `otpauth://totp/Nimbus:${encodeURIComponent(u.email)}?secret=${secret}&issuer=Nimbus&algorithm=SHA1&digits=6&period=30`;
  json(res, 200, { secret, uri });
});
route('POST', '/api/mfa/enable', async (req, res) => {
  const u = currentUser(req);
  if (!u?.totp_secret) return json(res, 400, { error: 'Start setup first' });
  if (!checkTotp(u.totp_secret, (await body(req)).code)) return json(res, 400, { error: 'That code didn’t match. Check your phone’s time is correct and try the newest code.' });
  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
  q('UPDATE users SET totp_enabled=1, recovery=? WHERE email=?').run(JSON.stringify(codes.map((c) => hash(c).toString('hex'))), u.email);
  json(res, 200, { recovery: codes.map((c) => c.slice(0, 5) + '-' + c.slice(5)) });
});
route('POST', '/api/mfa/disable', async (req, res) => {
  const u = currentUser(req);
  if (!u?.totp_enabled) return json(res, 400, { error: 'Two-factor is not on' });
  const { password, code } = await body(req);
  const pwOk = crypto.timingSafeEqual(Buffer.from(hashPassword(password || '', u.salt), 'hex'), Buffer.from(u.pw_hash, 'hex'));
  if (!pwOk || !(checkTotp(u.totp_secret, code) || useRecoveryCode(u, code))) return json(res, 400, { error: 'Wrong password or code' });
  q("UPDATE users SET totp_enabled=0, totp_secret='', recovery='[]' WHERE email=?").run(u.email);
  json(res, 200, { ok: true });
});
route('POST', '/api/logout', (req, res) => {
  const t = cookieToken(req);
  if (t) q('DELETE FROM auth_sessions WHERE token=?').run(t);
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'nimbus_session=; Path=/; Max-Age=0' });
  res.end('{"ok":true}');
});

// Local admin access for scripts and bots on this server (bin/nimbus.mjs). The token file is
// readable only by the Nimbus user, and the header is honoured only from localhost.
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin.token');
if (!fs.existsSync(ADMIN_TOKEN_FILE)) fs.writeFileSync(ADMIN_TOKEN_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
function adminAuth(req) {
  const t = String(req.headers['x-nimbus-admin'] || '');
  return t.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_TOKEN))
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
}

const OPEN_PATHS = new Set(['/nimbus.webp', '/login', '/api/login', '/api/login/mfa', '/api/signup', '/api/auth-methods', '/icon.svg', '/manifest.webmanifest', '/styles.css']);
function checkAuth(req, res, url) {
  if (url.pathname.startsWith('/api/hook/') || OPEN_PATHS.has(url.pathname) || adminAuth(req) || loggedIn(req)) {
    // Mutating API calls must be JSON: blocks form-based cross-site requests.
    if (req.method !== 'GET' && url.pathname.startsWith('/api/') && !String(req.headers['content-type']).includes('application/json')) {
      json(res, 415, { error: 'JSON required' }); return false;
    }
    return true;
  }
  if (url.pathname.startsWith('/api/')) { json(res, 401, { error: 'login required' }); return false; }
  res.writeHead(302, { location: '/login' }); res.end();
  return false;
}

// ---------- bot desktop proxy ----------
// The desktop on the computer VM uses HTTP basic auth, which browsers won't prompt for inside a
// cross-origin iframe. Nimbus serves it at /computer/<botId>/ instead and adds the credentials itself,
// so only someone logged in to Nimbus can see a bot's screen. WebSockets (the live screen) go through too.
const deskCache = new Map(); // botId -> { at, info }
async function deskInfo(id) {
  const c = deskCache.get(id);
  if (c && Date.now() - c.at < 60_000) return c.info;
  let info = await agent(`/computers/${id}`);
  if (info.exists && !info.running) info = await agent(`/computers/${id}`, { method: 'POST' }); // asleep: wake it
  if (!info.exists || !info.port) throw new Error('This bot’s computer isn’t running');
  const r = { host: new URL(agentConfig().url).hostname, port: info.port, auth: 'Basic ' + Buffer.from(`${info.user}:${info.password}`).toString('base64') };
  deskCache.set(id, { at: Date.now(), info: r });
  return r;
}
const DESK_RE = /^\/computer\/(\d+)(\/.*)?$/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization']);
async function proxyDesktop(req, res, m, url) {
  deskSeen.set(Number(m[1]), Date.now());
  if (!m[2]) { res.writeHead(302, { location: `/computer/${m[1]}/` }); return res.end(); }
  let d;
  try { d = await deskInfo(Number(m[1])); } catch (e) { res.writeHead(502, { 'content-type': 'text/plain' }); return res.end(e.message); }
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
  const up = http.request({ host: d.host, port: d.port, method: req.method, path: m[2] + url.search, headers: { ...headers, host: `${d.host}:${d.port}`, authorization: d.auth } }, (r) => {
    const h = { ...r.headers }; delete h['x-frame-options']; delete h['www-authenticate'];
    if (r.statusCode === 401) deskCache.delete(Number(m[1])); // password changed, e.g. computer recreated
    res.writeHead(r.statusCode, h); r.pipe(res);
  });
  up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Couldn’t reach the bot’s computer: ' + e.message); } else res.destroy(); });
  req.pipe(up);
}
async function proxyDesktopUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(DESK_RE);
  if (!m || !loggedIn(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  deskSeen.set(Number(m[1]), Date.now());
  let d;
  try { d = await deskInfo(Number(m[1])); } catch { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
  const up = net.connect(d.port, d.host, () => {
    const lines = [`${req.method} ${(m[2] || '/') + url.search} HTTP/1.1`, `Host: ${d.host}:${d.port}`, `Authorization: ${d.auth}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (!['host', 'cookie', 'authorization', 'origin'].includes(k.toLowerCase())) lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Origin: http://${d.host}:${d.port}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const watching = setInterval(() => deskSeen.set(Number(m[1]), Date.now()), 60_000); // screen open = not idle
  const close = () => { clearInterval(watching); up.destroy(); socket.destroy(); };
  up.on('error', close); socket.on('error', close); socket.on('close', close);
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    if (!checkAuth(req, res, url)) return;
    const desk = url.pathname.match(DESK_RE);
    if (desk) return await proxyDesktop(req, res, desk, url);
    if (url.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(LOGIN_PAGE); }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (m) return await r.fn(req, res, m.groups || {}, url);
    }
    if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    let file = path.join(PUBLIC, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
}
const onUpgrade = (req, socket, head) => { proxyDesktopUpgrade(req, socket, head).catch(() => socket.destroy()); };
const server = http.createServer(handle);
server.on('upgrade', onUpgrade);

// HTTPS on a second port with a self-signed certificate made on first start (data/tls). Browsers only
// allow some features on secure pages: bot desktops (video decoding) and phone notifications need it.
// The certificate covers this server's IPs and hostname, and is remade when they change.
const HTTPS_PORT = Number(process.env.NIMBUS_HTTPS_PORT ?? 8443);
function tlsFiles() {
  const dir = path.join(DATA_DIR, 'tls'); fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem'), names = path.join(dir, 'names.txt');
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address);
  const san = ['DNS:localhost', `DNS:${os.hostname()}`, 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  if (!fs.existsSync(cert) || !fs.existsSync(names) || fs.readFileSync(names, 'utf8') !== san) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', key, '-out', cert,
      '-subj', '/CN=Nimbus', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
    fs.chmodSync(key, 0o600); fs.writeFileSync(names, san);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
if (HTTPS_PORT) {
  try {
    const secure = https.createServer(tlsFiles(), handle);
    secure.on('upgrade', onUpgrade);
    secure.on('error', (e) => console.error(`HTTPS not started: ${e.message}`));
    secure.listen(HTTPS_PORT, HOST, () => console.log(`Nimbus HTTPS at https://<this server>:${HTTPS_PORT} (self-signed certificate)`));
  } catch (e) { console.error(`HTTPS not started: ${e.message}`); }
}
server.listen(PORT, HOST, () => {
  const shown = ['0.0.0.0', '::'].includes(HOST) ? 'localhost' : HOST;
  console.log(`Nimbus running at http://${shown}:${PORT}${shown !== HOST ? ` (listening on all interfaces, ${HOST})` : ''}`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
