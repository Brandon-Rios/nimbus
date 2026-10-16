#!/usr/bin/env node
// Nimbus computer agent. Runs on the Proxmox VM next to Docker and gives each bot its own
// desktop container (nimbus-bot-<id>). Nimbus calls it over HTTP with a shared token.
// No npm packages; needs Node 22+ and the docker CLI.
//
//   AGENT_TOKEN=long-random-string node agent.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

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
async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 5e6) throw new Error('too large'); }
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
  const { args = [], prompt = '', env = {}, files = {}, runId } = await body(req);
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

http.createServer(async (req, res) => {
  try {
    const auth = String(req.headers.authorization || '');
    const ok = auth.length === TOKEN.length + 7 && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from('Bearer ' + TOKEN));
    if (!ok) return json(res, 401, { error: 'bad token' });
    const m = req.url.match(/^\/computers\/(\d+)(\/run)?$/);
    if (req.url === '/health') return json(res, 200, { ok: true, docker: (await docker(['version', '-f', '{{.Server.Version}}'])).out || null });
    if (!m) return json(res, 404, { error: 'not found' });
    const id = Number(m[1]);
    if (m[2] && req.method === 'POST') return await run(req, res, id);
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
