// Files people and bots work on together: uploads, versions, previews, sharing and in-browser editing.
// Every file is an upload (data/uploads/<id>/). Uploads that belong to a chat are grouped into a "doc":
// the same name in the same chat is one doc, and each change is a new version, so nothing is overwritten.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { db, q, DATA_DIR, botDir } from './db.js';
// Single-user Nimbus: whoever is signed in owns everything.
const canSeeThread = () => true, isAdmin = () => true, getAccount = () => null, toStored = (u, t) => t;

export const UPLOADS = path.join(DATA_DIR, 'uploads');
export const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_BOT_FILE = 100 * 1024 * 1024;
export const safeName = (n) => String(n || 'file').replace(/[\/\\\0]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';
export const uploadPath = (f) => path.join(UPLOADS, f.id, f.name);
export function readUpload(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(UPLOADS, id, 'meta.json'), 'utf8')); } catch { return null; }
}
const writeMeta = (f) => fs.writeFileSync(path.join(UPLOADS, f.id, 'meta.json'), JSON.stringify(f));

const TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet', '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.html': 'text/html'
};
export const typeFor = (name) => TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
const OFFICE = /\.(docx?|xlsx?|pptx?|od[tsp]|rtf)$/i;
const EDITABLE = /\.(docx?|xlsx?|pptx?|od[tsp]|rtf|csv|txt)$/i;
// Old Office formats are converted to the modern one the first time someone edits them.
const LEGACY = { doc: 'docx', xls: 'xlsx', ppt: 'pptx', rtf: 'docx' };
export const isOffice = (name) => OFFICE.test(name);

export function saveUpload(name, buf, extra = {}) {
  const f = { id: crypto.randomBytes(12).toString('hex'), name: safeName(name), type: extra.type || typeFor(name), size: buf.length, ...extra };
  fs.mkdirSync(path.join(UPLOADS, f.id), { recursive: true });
  fs.writeFileSync(uploadPath(f), buf);
  writeMeta(f);
  return f;
}

db.exec(`
CREATE TABLE IF NOT EXISTS file_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, name TEXT NOT NULL, owner_id INTEGER,
  latest TEXT, created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS file_docs_thread_name ON file_docs(thread, name);
CREATE TABLE IF NOT EXISTS file_versions (
  doc_id INTEGER, upload_id TEXT PRIMARY KEY, version INTEGER, author TEXT, created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS file_shares (doc_id INTEGER, user_id INTEGER, shared_by INTEGER, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (doc_id, user_id));
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY, doc_id INTEGER, created_by INTEGER, expires_at INTEGER, revoked INTEGER DEFAULT 0,
  downloads INTEGER DEFAULT 0, created_at INTEGER DEFAULT (unixepoch())
);
`);

// Adds an upload to a chat as a new version of the doc with that name (or as a new doc).
// author: 'user:<id>', 'bot:<id>' or 'editor:<id>'.
export function addVersion(thread, f, author, ownerId = null) {
  let doc = q('SELECT * FROM file_docs WHERE thread=? AND name=?').get(thread, f.name);
  if (!doc) {
    const r = q('INSERT INTO file_docs (thread, name, owner_id) VALUES (?,?,?)').run(thread, f.name, ownerId);
    doc = q('SELECT * FROM file_docs WHERE id=?').get(Number(r.lastInsertRowid));
  }
  const version = (q('SELECT MAX(version) AS v FROM file_versions WHERE doc_id=?').get(doc.id).v || 0) + 1;
  q('INSERT OR IGNORE INTO file_versions (doc_id, upload_id, version, author) VALUES (?,?,?,?)').run(doc.id, f.id, version, author);
  q('UPDATE file_docs SET latest=?, updated_at=unixepoch() WHERE id=?').run(f.id, doc.id);
  Object.assign(f, { doc: doc.id, version });
  writeMeta(f);
  return f;
}

export const getDoc = (id) => q('SELECT * FROM file_docs WHERE id=?').get(Number(id));
export function canOpenDoc(u, doc) {
  if (!doc) return false;
  return isAdmin(u) || doc.owner_id === u.id || canSeeThread(u, doc.thread) || !!q('SELECT 1 FROM file_shares WHERE doc_id=? AND user_id=?').get(doc.id, u.id);
}
// Uploads that aren't in a chat yet are private to whoever uploaded them. Older uploads (no owner) stay as they were.
export function canOpenUpload(u, f) {
  if (!f) return false;
  if (f.doc) return canOpenDoc(u, getDoc(f.doc));
  return f.owner == null || isAdmin(u) || f.owner === u.id;
}

function docView(doc) {
  const versions = q('SELECT v.*, v.created_at AS at FROM file_versions v WHERE doc_id=? ORDER BY version DESC').all(doc.id)
    .map((v) => ({ ...readUpload(v.upload_id), version: v.version, author: v.author, at: v.at, authorName: authorName(v.author) })).filter((v) => v.id);
  const shares = [], links = []; // no sharing in single-user Nimbus
  return { ...doc, versions, latest: versions[0] || null, shares, links, editable: EDITABLE.test(doc.name) && !!office() };
}
function authorName(a) {
  const [kind, id] = String(a).split(':');
  if (kind === 'bot') return q('SELECT name FROM bots WHERE id=?').get(Number(id))?.name || 'A bot';
  if (kind === 'user' || kind === 'editor') return 'You';
  return '';
}

// ---------- bots: chat files in, outbox out ----------
// Before each run, the latest version of every file in the chat is copied into the bot's workspace at
// chats/<chat>/<name>, so the bot always sees what people uploaded or edited. Anything it saves to outbox/,
// or changes in that folder, becomes a new version attached to its reply.
const threadKey = (thread) => String(thread).replace(/[^a-z0-9@]+/gi, '_');
export function chatFolder(botId, thread) {
  const dir = path.join(botDir(botId), 'chats', threadKey(thread));
  for (const d of [path.dirname(dir), dir]) if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fs.chmodSync(d, 0o2770); }
  return dir;
}
export function outbox(botId) {
  const dir = path.join(botDir(botId), 'outbox');
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, 0o2770); }
  return dir;
}
const STAMP = '.nimbus-versions.json';
export function prepareChatFiles(botId, thread) {
  const docs = q('SELECT * FROM file_docs WHERE thread=? ORDER BY updated_at DESC LIMIT 50').all(thread);
  if (!docs.length) return { dir: null, files: [] };
  const dir = chatFolder(botId, thread);
  let stamp = {}; try { stamp = JSON.parse(fs.readFileSync(path.join(dir, STAMP), 'utf8')); } catch {}
  const files = [];
  for (const d of docs) {
    const f = readUpload(d.latest); if (!f) continue;
    const dest = path.join(dir, d.name);
    if (stamp[d.name]?.upload !== f.id || !fs.existsSync(dest)) {
      fs.copyFileSync(uploadPath(f), dest); try { fs.chmodSync(dest, 0o660); } catch {}
      const st = fs.statSync(dest);
      stamp[d.name] = { upload: f.id, size: st.size, mtime: st.mtimeMs };
    }
    files.push({ path: dest, name: d.name, version: f.version || 1 });
  }
  fs.writeFileSync(path.join(dir, STAMP), JSON.stringify(stamp)); try { fs.chmodSync(path.join(dir, STAMP), 0o660); } catch {}
  return { dir, files };
}
export function clearOutbox(botId) {
  const dir = outbox(botId);
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}
// After a run: collect what the bot made or changed. Returns the uploads to attach to its reply.
export function collectBotFiles(botId, thread, ownerId) {
  const out = [];
  const take = (file, name) => {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size === 0 || st.size > MAX_BOT_FILE || out.length >= 20) return;
      out.push(addVersion(thread, saveUpload(name, fs.readFileSync(file), { owner: ownerId }), `bot:${botId}`, ownerId));
    } catch (e) { console.error('collect file:', e.message); }
  };
  const box = outbox(botId);
  for (const n of fs.readdirSync(box)) if (!n.startsWith('.')) { take(path.join(box, n), n); fs.rmSync(path.join(box, n), { recursive: true, force: true }); }
  // Files the bot edited in place in the chat folder.
  const dir = path.join(botDir(botId), 'chats', threadKey(thread));
  if (fs.existsSync(dir)) {
    let stamp = {}; try { stamp = JSON.parse(fs.readFileSync(path.join(dir, STAMP), 'utf8')); } catch {}
    const taken = new Set(out.map((f) => f.name));
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith('.') || taken.has(n) || n.startsWith('~$') || n.startsWith('.~lock')) continue;
      const st = fs.statSync(path.join(dir, n));
      if (!st.isFile()) continue;
      const s = stamp[n];
      if (s && s.size === st.size && s.mtime === st.mtimeMs) continue;
      take(path.join(dir, n), n);
      const f = out.find((x) => x.name === safeName(n));
      if (f) stamp[n] = { upload: f.id, size: st.size, mtime: st.mtimeMs };
    }
    fs.writeFileSync(path.join(dir, STAMP), JSON.stringify(stamp));
  }
  return out;
}
export function chatFilesPrompt({ dir, files }, botId) {
  const box = outbox(botId);
  return `\n\n---\n${files.length ? `Files in this chat (latest versions):\n${files.map((f) => `- ${f.path} (v${f.version})`).join('\n')}\n` : ''}
To give the user a file (new, or an edited version), save it to ${box}/ — it is attached to your reply and the user can preview, download and share it. To edit a file from this chat, edit it in place or save the new version to the outbox with the same file name; earlier versions are kept.`;
}

// ---------- previews (LibreOffice → PDF) ----------
const SOFFICE = process.env.NIMBUS_SOFFICE || (process.platform === 'win32' ? 'soffice.exe' : 'soffice');
let convertQueue = Promise.resolve();
// Convert an upload to another format with LibreOffice (queued, one at a time); resolves to the new file's bytes.
function convertTo(f, ext) {
  const job = convertQueue.then(() => new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-conv-'));
    const src = path.join(tmp, 'in' + path.extname(f.name).toLowerCase());
    fs.copyFileSync(uploadPath(f), src);
    execFile(SOFFICE, [`-env:UserInstallation=file://${tmp}/profile`, '--headless', '--norestore', '--convert-to', ext, '--outdir', path.join(tmp, 'out'), src],
      { timeout: 120_000 }, (err) => {
        const out = path.join(tmp, 'out', 'in.' + ext);
        if (!err && fs.existsSync(out)) resolve(fs.readFileSync(out));
        else reject(new Error('Couldn’t convert this file to .' + ext + ' for editing.'));
        fs.rmSync(tmp, { recursive: true, force: true });
      });
  }));
  convertQueue = job.catch(() => {});
  return job;
}
function toPdf(f) {
  const out = path.join(UPLOADS, f.id, 'preview.pdf');
  if (fs.existsSync(out)) return Promise.resolve(out);
  const job = convertQueue.then(() => new Promise((resolve, reject) => {
    if (fs.existsSync(out)) return resolve(out);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-pdf-'));
    const src = path.join(tmp, 'in' + path.extname(f.name).toLowerCase());
    fs.copyFileSync(uploadPath(f), src);
    // A private LibreOffice profile per conversion, so a stuck or running LibreOffice can't block it.
    execFile(SOFFICE, [`-env:UserInstallation=file://${tmp}/profile`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp, src],
      { timeout: 120_000 }, (err) => {
        const pdf = path.join(tmp, 'in.pdf');
        if (!err && fs.existsSync(pdf)) { fs.copyFileSync(pdf, out); resolve(out); }
        else reject(new Error(err?.code === 'ENOENT' ? 'Previews need LibreOffice on the server (sudo apt-get install libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress).' : 'Couldn’t convert this file for preview.'));
        fs.rmSync(tmp, { recursive: true, force: true });
      });
  }));
  convertQueue = job.catch(() => {});
  return job;
}

// ---------- ONLYOFFICE (optional in-browser editing) ----------
// NIMBUS_ONLYOFFICE_URL: where Nimbus reaches the Document Server (e.g. http://127.0.0.1:8088). Browsers reach it
// through Nimbus at /office/, so it needs no port of its own. NIMBUS_ONLYOFFICE_SECRET: its JWT secret.
// NIMBUS_ONLYOFFICE_CALLBACK: how the Document Server reaches Nimbus (default https://host.docker.internal:8443).
function office() {
  const url = process.env.NIMBUS_ONLYOFFICE_URL;
  return url ? { url: url.replace(/\/$/, ''), secret: process.env.NIMBUS_ONLYOFFICE_SECRET || '', back: (process.env.NIMBUS_ONLYOFFICE_CALLBACK || `https://host.docker.internal:${process.env.NIMBUS_HTTPS_PORT || 8443}`).replace(/\/$/, '') } : null;
}
const b64url = (b) => Buffer.from(b).toString('base64url');
function jwtSign(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
function jwtVerify(token, secret) {
  const [h, b, s] = String(token || '').split('.');
  if (!s) return null;
  const want = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  if (want.length !== s.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s))) return null;
  try { return JSON.parse(Buffer.from(b, 'base64url').toString()); } catch { return null; }
}
// Short-lived signed links the Document Server uses to fetch a file and report saves (it has no login).
const LINK_KEY = crypto.randomBytes(32);
const sign = (s) => crypto.createHmac('sha256', LINK_KEY).update(s).digest('hex').slice(0, 32);
const signed = (s, ttl = 12 * 3600) => { const exp = Math.floor(Date.now() / 1000) + ttl; return `exp=${exp}&sig=${sign(`${s}:${exp}`)}`; };
const checkSigned = (s, url) => { const exp = Number(url.searchParams.get('exp')); return exp > Date.now() / 1000 && url.searchParams.get('sig') === sign(`${s}:${exp}`); };

function fetchBuffer(u) {
  return new Promise((resolve, reject) => {
    (u.startsWith('https:') ? https : http).get(u, { rejectUnauthorized: false }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`HTTP ${r.statusCode}`)); }
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Proxies /office/* (including websockets) to the Document Server so the editor works on Nimbus's own address.
export function officeProxy(req, res, url) {
  const o = office();
  if (!o) { res.writeHead(404); return res.end(); }
  const target = new URL(o.url + url.pathname.replace(/^\/office/, '') + url.search);
  const headers = { ...req.headers, host: target.host, 'x-forwarded-host': `${req.headers.host}/office`, 'x-forwarded-proto': req.socket.encrypted ? 'https' : 'http' };
  delete headers.cookie; // Nimbus's session stays with Nimbus
  const p = http.request(target, { method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Document editor isn’t reachable'); });
  req.pipe(p);
}
export function officeUpgrade(req, socket, head) {
  const o = office();
  if (!o) return socket.destroy();
  const target = new URL(o.url + req.url.replace(/^\/office/, ''));
  const headers = { ...req.headers, host: target.host, 'x-forwarded-host': `${req.headers.host}/office`, 'x-forwarded-proto': req.socket.encrypted ? 'https' : 'http' };
  delete headers.cookie;
  const p = http.request(target, { headers });
  p.on('upgrade', (r, up, upHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (upHead?.length) socket.write(upHead);
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
  });
  p.on('error', () => socket.destroy());
  p.end();
}

// ---------- routes ----------
export function registerFiles(route, { json, body, broadcast, addNote }) {
  const docOr403 = (req, res, id) => {
    const doc = getDoc(id);
    if (!doc) { json(res, 404, { error: 'No such file' }); return null; }
    if (!canOpenDoc(req.user, doc)) { json(res, 403, { error: 'This file isn’t shared with you' }); return null; }
    return doc;
  };
  const canChange = (u, doc) => isAdmin(u) || doc.owner_id === u.id || canSeeThread(u, doc.thread);

  // The Files tab of a chat, and files shared with me.
  route('GET', '/api/filedocs', (req, res, p, url) => {
    const thread = url.searchParams.get('thread');
    let rows;
    if (thread) {
      const t = toStored(req.user, thread);
      if (!canSeeThread(req.user, t)) return json(res, 403, { error: 'Not your chat' });
      rows = q('SELECT * FROM file_docs WHERE thread=? ORDER BY updated_at DESC').all(t);
    } else rows = [];
    json(res, 200, rows.map(docView));
  });
  route('GET', '/api/filedocs/:id', (req, res, p) => { const d = docOr403(req, res, p.id); if (d) json(res, 200, docView(d)); });

  // Preview: a PDF of any Office file (made once per version, then cached), or the file itself.
  route('GET', '/api/preview/:id', async (req, res, p, url) => {
    const f = readUpload(p.id);
    if (!f || !canOpenUpload(req.user, f)) return json(res, 404, { error: 'not found' });
    try {
      const pdf = f.type === 'application/pdf' ? uploadPath(f) : await toPdf(f);
      const name = f.name.replace(/\.[^.]+$/, '') + '.pdf';
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': fs.statSync(pdf).size, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable',
        'content-disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}` });
      fs.createReadStream(pdf).pipe(res);
    } catch (e) { json(res, 501, { error: e.message }); }
  });

  // Restore an older version: it becomes the newest one.
  route('POST', '/api/filedocs/:id/restore', async (req, res, p) => {
    const doc = docOr403(req, res, p.id); if (!doc) return;
    if (!canChange(req.user, doc)) return json(res, 403, { error: 'Not yours to change' });
    const v = readUpload((await body(req)).uploadId);
    if (!v || v.doc !== doc.id) return json(res, 400, { error: 'No such version' });
    addVersion(doc.thread, saveUpload(doc.name, fs.readFileSync(uploadPath(v)), { owner: v.owner }), 'user:0');
    broadcast('docs_changed', { thread: doc.thread });
    json(res, 200, docView(getDoc(doc.id)));
  });

  // ONLYOFFICE editor config for the latest version of a doc.
  // Save edited text (the HTML/text editor in the side pane) as a new version.
  route('POST', '/api/filedocs/:id/content', async (req, res, p) => {
    const doc = docOr403(req, res, p.id); if (!doc) return;
    if (!canChange(req.user, doc)) return json(res, 403, { error: 'Not yours to change' });
    if (!/\.(html?|css|js|md|txt|csv|json|svg)$/i.test(doc.name)) return json(res, 400, { error: 'Only text files can be edited here' });
    const { text } = await body(req, MAX_UPLOAD + 1000);
    const buf = Buffer.from(String(text ?? ''), 'utf8');
    if (buf.length > MAX_UPLOAD) return json(res, 413, { error: 'Too big' });
    addVersion(doc.thread, saveUpload(doc.name, buf, { owner: doc.owner_id }), 'user:0');
    broadcast('docs_changed', { thread: doc.thread });
    json(res, 200, docView(getDoc(doc.id)));
  });

  route('GET', '/api/filedocs/:id/editor', async (req, res, p) => {
    let doc = docOr403(req, res, p.id); if (!doc) return;
    const o = office();
    if (!o) return json(res, 501, { error: 'In-browser editing isn’t set up on this server. See deploy/OFFICE.md.' });
    if (!canChange(req.user, doc)) return json(res, 403, { error: 'You can view this file but not edit it' });
    let f = readUpload(doc.latest);
    const old = LEGACY[path.extname(f.name).slice(1).toLowerCase()];
    if (old) {
      // e.g. quote.xls → quote.xlsx, a new file in the same chat (the original stays as it was).
      let buf; try { buf = await convertTo(f, old); } catch (e) { return json(res, 500, { error: e.message }); }
      const name = f.name.replace(/\.[^.]+$/, '.' + old);
      f = addVersion(doc.thread, saveUpload(name, buf, { owner: doc.owner_id }), 'user:0', doc.owner_id);
      doc = getDoc(f.doc);
      broadcast('docs_changed', { thread: doc.thread });
    }
    const ext = path.extname(f.name).slice(1).toLowerCase();
    const documentType = /^(xlsx?|ods|csv)$/.test(ext) ? 'cell' : /^(pptx?|odp)$/.test(ext) ? 'slide' : 'word';
    const config = {
      document: { fileType: ext, key: f.id, title: f.name, url: `${o.back}/api/office/file/${f.id}?${signed(f.id)}`, permissions: { edit: true, download: true, print: true } },
      documentType,
      editorConfig: {
        callbackUrl: `${o.back}/api/office/callback/${doc.id}?${signed('cb' + doc.id)}`,
        user: { id: '0', name: 'You' },
        customization: { forcesave: true, autosave: true }, lang: 'en'
      }
    };
    if (o.secret) config.token = jwtSign(config, o.secret);
    json(res, 200, { config, api: '/office/web-apps/apps/api/documents/api.js', doc: old ? docView(doc) : undefined });
  });
  // Live saving: while someone edits, the page asks for a save now and then, so the bot sees changes without
  // waiting for the editor to close. The Document Server answers via the callback (status 6) only if something changed.
  route('POST', '/api/filedocs/:id/forcesave', async (req, res, p) => {
    const doc = docOr403(req, res, p.id); if (!doc) return;
    const o = office(); if (!o) return json(res, 501, { error: 'Editing isn’t set up' });
    if (!canChange(req.user, doc)) return json(res, 403, { error: 'Not yours to change' });
    const { key } = await body(req);
    const cmd = { c: 'forcesave', key: String(key || '') };
    if (o.secret) cmd.token = jwtSign(cmd, o.secret);
    try {
      const r = await fetch(`${o.url}/coauthoring/CommandService.ashx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(10_000) });
      const j = await r.json().catch(() => ({}));
      json(res, 200, { error: j.error ?? 0 }); // 4 = nothing changed since the last save
    } catch (e) { json(res, 502, { error: e.message }); }
  });
  // Called by the Document Server (no login; checked by signature and JWT).
  route('GET', '/api/office/file/:id', (req, res, p, url) => {
    const f = readUpload(p.id);
    if (!f || !checkSigned(f.id, url)) return json(res, 403, { error: 'bad link' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': f.size });
    fs.createReadStream(uploadPath(f)).pipe(res);
  });
  route('POST', '/api/office/callback/:doc', async (req, res, p, url) => {
    const o = office(); const doc = getDoc(p.doc);
    if (!o || !doc || !checkSigned('cb' + doc.id, url)) return json(res, 403, { error: 1 });
    let b = await body(req, 1e6);
    if (o.secret) { b = jwtVerify(b.token || String(req.headers.authorization || '').replace(/^Bearer /, ''), o.secret); if (!b) return json(res, 403, { error: 1 }); b = b.payload || b; }
    // 2 = all editors closed with changes, 6 = force-save while open.
    if ((b.status === 2 || b.status === 6) && b.url) {
      try {
        const local = new URL(b.url); // fetch from the Document Server directly, not through the browser's address
        const buf = await fetchBuffer(o.url + local.pathname.replace(/^\/office/, '') + local.search);
        const editor = Number(b.users?.[0]) || null;
        const f = addVersion(doc.thread, saveUpload(doc.name, buf, { owner: doc.owner_id }), `editor:${editor ?? ''}`);
        if (b.status === 2) addNote(doc.thread, `✏️ ${(editor && getAccount(editor)?.name) || 'Someone'} edited ${doc.name} (v${f.version}).`, [f]);
        broadcast('docs_changed', { thread: doc.thread });
      } catch (e) { console.error('office save:', e.message); return json(res, 200, { error: 1 }); }
    }
    json(res, 200, { error: 0 });
  });
}
