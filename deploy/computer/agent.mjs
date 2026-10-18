#!/usr/bin/env node
// Nimbus computer agent. Runs on the Proxmox VM next to Docker and gives each bot its own
// desktop container (nimbus-bot-<id>). Nimbus calls it over HTTP with a shared token.
// No npm packages; needs Node 22+ and the docker CLI.
//
//   AGENT_TOKEN=long-random-string node agent.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TOKEN = process.env.AGENT_TOKEN || '';
const PORT = Number(process.env.AGENT_PORT || 8788);
const IMAGE = process.env.AGENT_IMAGE || 'nimbus-computer';
const FIRST_PORT = Number(process.env.AGENT_FIRST_PORT || 3100);
const TZ = process.env.TZ || 'Etc/UTC';
const CLAUDE_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
if (TOKEN.length < 16) { console.error('Set AGENT_TOKEN to a long random string (16+ characters).'); process.exit(1); }

const name = (id) => `nimbus-bot-${Number(id)}`;
function docker(args, input) {
  return new Promise((resolve) => {
    const p = spawn('docker', args);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}
const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
async function body(req, limit = 5e6) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > limit) throw new Error('too large'); }
  return s ? JSON.parse(s) : {};
}

async function info(id) {
  const r = await docker(['inspect', '-f', '{{.State.Running}}|{{index .Config.Labels "nimbus.port"}}|{{index .Config.Labels "nimbus.password"}}', name(id)]);
  if (r.code !== 0) return { exists: false };
  const [running, port, password] = r.out.split('|');
  return { exists: true, running: running === 'true', port: Number(port), user: 'nimbus', password };
}
async function ensure(id) {
  const cur = await info(id);
  if (cur.exists) {
    if (!cur.running) { const r = await docker(['start', name(id)]); if (r.code) throw new Error(r.err); }
    return { ...cur, running: true };
  }
  const used = (await docker(['ps', '-a', '--filter', 'label=nimbus.bot', '--format', '{{.Label "nimbus.port"}}'])).out.split('\n').map(Number);
  let port = FIRST_PORT;
  while (used.includes(port)) port++;
  const password = crypto.randomBytes(12).toString('base64url');
  const r = await docker(['run', '-d', '--name', name(id), '--hostname', name(id), '--restart', 'unless-stopped',
    '-p', `${port}:3000`, '--shm-size', '1g', '-v', `${name(id)}:/config`,
    '-e', 'PUID=1000', '-e', 'PGID=1000', '-e', `TZ=${TZ}`, '-e', 'CUSTOM_USER=nimbus', '-e', `PASSWORD=${password}`,
    '--label', `nimbus.bot=${Number(id)}`, '--label', `nimbus.port=${port}`, '--label', `nimbus.password=${password}`, IMAGE]);
  if (r.code) throw new Error(r.err || 'docker run failed');
  // The desktop takes a few seconds to create its user and home folder.
  for (let i = 0; i < 30; i++) {
    if ((await docker(['exec', name(id), 'test', '-d', '/config'])).code === 0 && (await docker(['exec', name(id), 'id', 'abc'])).code === 0) break;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return { exists: true, running: true, port, user: 'nimbus', password };
}

// Run Claude Code inside the bot's computer and stream its output back as JSON lines:
// {"t":"out"|"err","d":"..."} while it runs, then {"t":"exit","code":0,"memory":"..."}.
async function run(req, res, id) {
  const { args = [], prompt = '', env = {}, files = {}, uploads = {}, runId } = await body(req, 80e6);
  await ensure(id);
  const n = name(id), work = '/config/work';
  await docker(['exec', '-u', 'abc', n, 'mkdir', '-p', work]);
  // Anything run as root in the container (e.g. while debugging) can leave root-owned files in the
  // bot's home, which breaks npx and the Browser plugin for the bot user. Hand them back first.
  await docker(['exec', n, 'sh', '-c', 'for d in /config/.npm /config/.cache; do [ -d "$d" ] && chown -R abc:abc "$d"; done; true']);
  for (const [file, text] of Object.entries(files)) {
    if (!/^[\w.-]+$/.test(file)) continue;
    await docker(['exec', '-i', '-u', 'abc', n, 'sh', '-c', `mkdir -p ${work} && cat > ${work}/${file}`], String(text));
  }
  // Files the user attached in Nimbus, as "<upload id>/<file name>": base64, into ~/work/uploads/.
  for (const [rel, b64] of Object.entries(uploads)) {
    const m = rel.match(/^([a-f0-9]{24})\/([^/\0]{1,120})$/);
    if (!m || m[2].startsWith('.')) continue;
    const dir = `${work}/uploads/${m[1]}`;
    await docker(['exec', '-i', '-u', 'abc', n, 'sh', '-c', 'mkdir -p "$1" && cat > "$1/$2"', 'sh', dir, m[2]], Buffer.from(String(b64), 'base64'));
  }
  const pidFile = `/tmp/nimbus-run-${Number(runId) || 0}.pid`;
  const envArgs = Object.entries({ HOME: '/config', DISPLAY: ':1', PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright', ...(CLAUDE_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN } : {}), ...env })
    .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const p = spawn('docker', ['exec', '-i', '-u', 'abc', '-w', work, ...envArgs, n,
    'sh', '-c', `echo $$ > ${pidFile}; exec claude "$@"`, 'claude', ...args]);
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const send = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
  p.stdout.on('data', (d) => send({ t: 'out', d: String(d) }));
  p.stderr.on('data', (d) => send({ t: 'err', d: String(d) }));
  p.stdin.on('error', () => {});
  p.stdin.end(prompt);
  let done = false;
  // Nimbus pressed Stop (or went away): stop Claude inside the container, not just the docker client.
  res.on('close', () => { if (!done) docker(['exec', n, 'sh', '-c', `kill $(cat ${pidFile}) 2>/dev/null`]); });
  p.on('error', (e) => send({ t: 'err', d: e.message }));
  p.on('close', async (code) => {
    done = true;
    const mem = await docker(['exec', '-u', 'abc', n, 'cat', `${work}/MEMORY.md`]);
    send({ t: 'exit', code, memory: mem.code === 0 ? mem.out + '\n' : null });
    res.end();
  });
}

// ---------- status of all computers ----------
async function list() {
  const ps = await docker(['ps', '-a', '--filter', 'label=nimbus.bot', '--format', '{{.Label "nimbus.bot"}}|{{.State}}|{{.Names}}']);
  const stats = await docker(['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}']);
  const mem = Object.fromEntries(stats.out.split('\n').filter(Boolean).map((l) => { const [n, m, c] = l.split('|'); return [n, { mem: m.split(' / ')[0], cpu: c }]; }));
  const computers = ps.out.split('\n').filter(Boolean).map((l) => { const [bot, state, n] = l.split('|'); return { bot: Number(bot), running: state === 'running', ...(mem[n] || {}) }; });
  const total = os.totalmem(), free = os.freemem();
  return { computers, vm: { memTotal: total, memUsed: total - free, cpus: os.cpus().length, load: os.loadavg()[0] } };
}

// ---------- files in a bot's home folder ----------
// Only inside /config (the bot's home volume); paths are relative to it.
function safeRel(p) {
  const rel = path.posix.normalize('/' + String(p || '')).replace(/^\/+/, '');
  if (rel.split('/').some((x) => x === '..')) throw new Error('bad path');
  return rel;
}
async function listFiles(id, dir) {
  const rel = safeRel(dir), abs = '/config/' + rel;
  const r = await docker(['exec', '-u', 'abc', name(id), 'find', abs, '-mindepth', '1', '-maxdepth', '1', '-not', '-name', '.*', '-printf', '%y|%s|%T@|%f\\n']);
  if (r.code !== 0) return { dir: rel, items: [], error: r.err.includes('No such') ? 'Folder not found' : r.err };
  const items = r.out.split('\n').filter(Boolean).map((l) => { const [t, size, mtime, ...nm] = l.split('|'); return { name: nm.join('|'), dir: t === 'd', size: Number(size), mtime: Math.round(Number(mtime)) }; })
    .sort((a, b) => (b.dir - a.dir) || b.mtime - a.mtime);
  return { dir: rel, items };
}
async function sendFile(res, id, p) {
  const rel = safeRel(p);
  const st = await docker(['exec', '-u', 'abc', name(id), 'stat', '-c', '%F|%s', '/config/' + rel]);
  if (st.code !== 0 || !st.out.startsWith('regular file')) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.out.split('|')[1] });
  const c = spawn('docker', ['exec', '-u', 'abc', name(id), 'cat', '/config/' + rel]);
  c.stdout.pipe(res);
  c.on('error', () => res.destroy());
}

// ---------- rebuild the image and recreate computers (home folders are kept) ----------
let updateState = { running: false, log: '', done: null, ok: null };
async function startUpdate({ dockerfile, hook }) {
  if (updateState.running) return updateState;
  if (!dockerfile || !hook) throw new Error('dockerfile and hook are required');
  updateState = { running: true, log: 'Building the computer image…\n', started: Date.now(), done: null, ok: null };
  (async () => {
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-build-'));
    try {
      fs.mkdirSync(path.join(ctx, 'hooks'));
      fs.mkdirSync(path.join(ctx, 'deploy/computer'), { recursive: true });
      fs.writeFileSync(path.join(ctx, 'deploy/computer/Dockerfile'), dockerfile);
      fs.writeFileSync(path.join(ctx, 'hooks/approval-hook.js'), hook);
      const b = await docker(['build', '--pull', '--build-arg', `CACHEBUST=${Date.now()}`, '-f', path.join(ctx, 'deploy/computer/Dockerfile'), '-t', IMAGE, ctx]);
      updateState.log += (b.err || b.out).split('\n').slice(-15).join('\n') + '\n';
      if (b.code !== 0) throw new Error('image build failed');
      const ids = (await docker(['ps', '-a', '--filter', 'label=nimbus.bot', '--format', '{{.Label "nimbus.bot"}}|{{.State}}'])).out.split('\n').filter(Boolean);
      for (const l of ids) {
        const [id, state] = l.split('|');
        await docker(['rm', '-f', name(id)]);
        if (state === 'running') await ensure(id); else { await ensure(id); await docker(['stop', name(id)]); }
        updateState.log += `Recreated computer for bot ${id}\n`;
      }
      await docker(['image', 'prune', '-f']);
      updateState.ok = true;
    } catch (e) { updateState.ok = false; updateState.log += 'Error: ' + e.message + '\n'; }
    finally { updateState.running = false; updateState.done = Date.now(); fs.rmSync(ctx, { recursive: true, force: true }); }
  })();
  return updateState;
}

http.createServer(async (req, res) => {
  try {
    const auth = String(req.headers.authorization || '');
    const ok = auth.length === TOKEN.length + 7 && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from('Bearer ' + TOKEN));
    if (!ok) return json(res, 401, { error: 'bad token' });
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return json(res, 200, { ok: true, docker: (await docker(['version', '-f', '{{.Server.Version}}'])).out || null });
    if (url.pathname === '/computers' && req.method === 'GET') return json(res, 200, await list());
    if (url.pathname === '/update') return req.method === 'POST' ? json(res, 200, await startUpdate(await body(req))) : json(res, 200, updateState);
    const m = url.pathname.match(/^\/computers\/(\d+)(\/run|\/stop|\/files|\/file)?$/);
    if (!m) return json(res, 404, { error: 'not found' });
    const id = Number(m[1]);
    if (m[2] === '/run' && req.method === 'POST') return await run(req, res, id);
    if (m[2] === '/stop' && req.method === 'POST') { await docker(['stop', '-t', '10', name(id)]); return json(res, 200, await info(id)); }
    if (m[2] === '/files') return json(res, 200, await listFiles(id, url.searchParams.get('dir') || ''));
    if (m[2] === '/file') return await sendFile(res, id, url.searchParams.get('path') || '');
    if (req.method === 'GET') return json(res, 200, await info(id));
    if (req.method === 'POST') return json(res, 200, await ensure(id));
    if (req.method === 'DELETE') {
      await docker(['rm', '-f', name(id)]);
      await docker(['volume', 'rm', name(id)]);
      return json(res, 200, { ok: true });
    }
    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Nimbus computer agent on :${PORT}`));
