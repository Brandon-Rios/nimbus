import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { q, parseBot, writeBotBrief, getSetting, ASK_BOT } from './db.js';
import { redact } from './redact.js';
import { broadcast } from './events.js';
import { PLUGINS } from './catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'hooks', 'approval-hook.js');
export const CLAUDE_BIN = process.env.CLAUDE_BIN || findClaude();

// Node can't launch npm's `claude.cmd` shim directly on Windows, so look for a real
// claude.exe: on PATH, from the native installer, or bundled with the Claude desktop app.
function findClaude() {
  if (process.platform !== 'win32') return 'claude';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  for (const d of dirs) {
    const exe = path.join(d, 'claude.exe');
    if (fs.existsSync(exe)) return exe;
  }
  const bundled = path.join(process.env.APPDATA || '', 'Claude', 'claude-code');
  try {
    const versions = fs.readdirSync(bundled)
      .filter((v) => fs.existsSync(path.join(bundled, v, 'claude.exe')))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length) return path.join(bundled, versions[0], 'claude.exe');
  } catch {}
  return 'claude';
}
const RUN_TIMEOUT_MS = Number(process.env.NIMBUS_RUN_TIMEOUT_MIN || 45) * 60_000;
const MAX_HANDOFF_DEPTH = 4;
// Bots with their own computer run inside a container on the Nimbus computer VM (deploy/computer).
// Settings saved in the app win over env vars, and changes apply without a restart.
export const agentConfig = () => ({
  url: getSetting('agent_url', 'NIMBUS_AGENT_URL').replace(/\/+$/, ''),
  token: getSetting('agent_token', 'NIMBUS_AGENT_TOKEN'),
  // How a bot's computer reaches this Nimbus server for approvals, e.g. http://192.168.1.20:8787
  callback: getSetting('callback_url', 'NIMBUS_CALLBACK_URL').replace(/\/+$/, '')
});
export const computersOn = () => { const c = agentConfig(); return !!(c.url && c.token && c.callback); };
export async function agent(path, opts = {}) {
  const { url, token } = agentConfig();
  const res = await fetch(url + path, { ...opts, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Computer agent error ${res.status}`);
  return data;
}

// Looks like a child process to execute(), but the run happens on the bot's computer.
function remoteRun(bot, dir, runId, args, prompt, env) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on() {}, end() {} };
  const ac = new AbortController();
  child.kill = () => ac.abort();
  (async () => {
    let code = 1;
    try {
      const memFile = path.join(dir, 'MEMORY.md');
      const files = { 'CLAUDE.md': fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'MEMORY.md': fs.readFileSync(memFile, 'utf8'),
        'ask-bot.mjs': fs.readFileSync(ASK_BOT, 'utf8') }; // lets this bot message its teammates
      // Attachments live on the Nimbus server; copy the ones this prompt mentions to the bot's computer
      // and point the prompt at the copies (~/work/uploads/<id>/<name>).
      const uploads = {};
      const upDir = path.join(path.dirname(dir), '..', 'uploads');
      let total = 0;
      prompt = prompt.replace(/(\/[^\s]*\/uploads\/([a-f0-9]{24})\/([^\n]+?)) \(/g, (all, abs, id, name) => {
        const local = path.join(upDir, id, name);
        if (!fs.existsSync(local) || path.resolve(local) !== path.resolve(abs)) return all;
        const buf = fs.readFileSync(local);
        if ((total += buf.length) > 50 * 1024 * 1024) return all; // keep a run's upload under 50 MB
        uploads[`${id}/${name}`] = buf.toString('base64');
        return `/config/work/uploads/${id}/${name} (`;
      });
      const res = await fetch(`${agentConfig().url}/computers/${bot.id}/run`, {
        method: 'POST', signal: ac.signal,
        headers: { authorization: `Bearer ${agentConfig().token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ args, prompt, env, files, uploads, runId })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.t === 'out') child.stdout.emit('data', m.d);
          else if (m.t === 'err') child.stderr.emit('data', m.d);
          else if (m.t === 'exit') { code = m.code ?? 1; if (typeof m.memory === 'string' && m.memory.trim()) fs.writeFileSync(memFile, m.memory); }
        }
      }
    } catch (e) {
      if (ac.signal.aborted) code = 143;
      else child.stderr.emit('data', `Couldn't run on this bot's computer: ${e.message}. Check the computer VM and the NIMBUS_AGENT_* settings.`);
    }
    child.emit('close', code);
  })();
  return child;
}

// Also sent over the LAN to bot computers, so it must be unguessable.
export const HOOK_TOKEN = process.env.NIMBUS_HOOK_TOKEN || randomBytes(24).toString('hex');

const queues = new Map();      // botId -> promise chain (one run at a time per bot)
const procs = new Map();       // runId -> child process
export const botStatus = new Map(); // botId -> { state, label }

// ---------- messages ----------
export function addMessage(thread, author, kind, body, runId = null, files = []) {
  const text = redact(typeof body === 'string' ? body : JSON.stringify(body));
  const r = q('INSERT INTO messages (thread, author, kind, body, run_id, files) VALUES (?,?,?,?,?,?)').run(thread, String(author), kind, text, runId, JSON.stringify(files));
  const msg = q('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid);
  broadcast('message', msg);
  return msg;
}

export function updateMessage(id, body) {
  q('UPDATE messages SET body=? WHERE id=?').run(redact(JSON.stringify(body)), id);
  broadcast('message_update', q('SELECT * FROM messages WHERE id=?').get(id));
}

function setStatus(botId, state, label) {
  botStatus.set(Number(botId), { state, label });
  broadcast('bot_status', { botId: Number(botId), state, label });
}

// ---------- trace helpers ----------
function summarizeTool(name, input = {}) {
  const arg = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  const s = arg != null ? String(arg) : JSON.stringify(input);
  const short = s.length > 90 ? s.slice(0, 87) + '…' : s;
  return `${name}(${short.replace(/\s+/g, ' ')})`;
}

// Traces are kept per run so the approval endpoint can mark a step as paused.
const liveTraces = new Map(); // runId -> { msgId, body }
const runClocks = new Map(); // runId -> { start, waited, since } (see the time limit in execute)
export function markTraceWaiting(runId, toolName, waiting) {
  const c = runClocks.get(Number(runId));
  if (c && waiting && !c.since) c.since = Date.now();
  if (c && !waiting && c.since) { c.waited += Date.now() - c.since; c.since = null; }
  const t = liveTraces.get(Number(runId));
  if (!t) return;
  const step = [...t.body.steps].reverse().find(s => s.tool === toolName && (s.state === 'running' || s.state === 'waiting'));
  if (step) { step.state = waiting ? 'waiting' : 'running'; updateMessage(t.msgId, t.body); }
}

// ---------- rooms ----------
export function roomMembers(roomId) {
  return q('SELECT b.* FROM bots b JOIN room_members m ON m.bot_id=b.id WHERE m.room_id=? ORDER BY b.id').all(roomId).map(parseBot);
}

export function findMentions(text, bots, excludeId = null) {
  const lower = text.toLowerCase();
  return bots.filter(b => {
    if (b.id === excludeId) return false;
    const full = '@' + b.name.toLowerCase();
    const first = '@' + b.name.toLowerCase().split(/\s+/)[0];
    return lower.includes(full) || new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(lower);
  });
}

function roomContext(roomId, bot) {
  const room = q('SELECT * FROM rooms WHERE id=?').get(roomId);
  const members = roomMembers(roomId);
  const lead = members.find(m => m.id === room.lead_bot_id);
  const names = new Map(members.map(m => [String(m.id), m.name]));
  const recent = q("SELECT * FROM messages WHERE thread=? AND kind='text' ORDER BY id DESC LIMIT 30").all('room:' + roomId).reverse();
  const transcript = recent.map(m => `[${m.author === 'user' ? 'User' : names.get(m.author) || 'Bot'}]: ${m.body}`).join('\n');
  return `You are in the group chat "#${room.name}".
Goal of this chat: ${room.goal || '(none set)'}
Members: ${members.map(m => `${m.name}${m.role ? ` (${m.role})` : ''}`).join(', ')}
Lead: ${lead ? lead.name : 'none'}${lead && lead.id === bot.id ? ' — that is you. Break the work up and assign it.' : ''}
${room.bots_can_talk ? 'To hand work to another bot, @mention them by full name in your reply with a clear ask, e.g. "@Dev Bot please build X". Only mention a bot when you need it to act.' : 'Other bots will not see mentions from you; talk to the user.'}
Shared files for this chat live in ../../rooms/${roomId}/ (create it if needed).

Recent messages:
${transcript || '(none)'}
`;
}

// Plugins the user switched on for this bot, as Claude Code MCP server configs.
// claude.ai connectors (Gmail etc.) aren't listed: Claude Code loads those itself.
function mcpServers(botId, remote = false) {
  const out = {};
  const rows = q('SELECT p.id, p.secrets FROM bot_plugins bp JOIN plugins p ON p.id = bp.plugin_id WHERE bp.bot_id=?').all(botId);
  for (const r of rows) {
    const pl = PLUGINS.find((x) => x.id === r.id);
    if (!pl?.server) continue;
    const cfg = pl.server(JSON.parse(r.secrets || '{}'));
    // npx is a .cmd shim on Windows, so it has to go through cmd.
    if (!remote && process.platform === 'win32' && cfg.command === 'npx') { cfg.args = ['/c', 'npx', ...cfg.args]; cfg.command = 'cmd'; }
    // Bot computers: one long-lived Chromium on the desktop you watch, which every run attaches to over
    // CDP. A browser started by the plugin itself would close at the end of each reply, and lose sign-ins.
    // Its profile lives in /config/browser-profile, so logins survive restarts.
    if (remote && pl.id === 'browser') {
      const sh = [
        'C=$(ls -d /opt/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)',
        'up() { curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null; }',
        // --no-sandbox: Chromium's sandbox can't start inside the container. The log helps when it won't start.
        'if ! up; then DISPLAY=${DISPLAY:-:1} setsid nohup "$C" --no-sandbox --remote-debugging-port=9222 --user-data-dir=/config/browser-profile --no-first-run --no-default-browser-check --start-maximized about:blank >/tmp/nimbus-chrome.log 2>&1 < /dev/null &',
        'for i in $(seq 1 40); do up && break; sleep 0.5; done; fi',
        `exec ${[cfg.command, ...cfg.args].join(' ')} --cdp-endpoint http://127.0.0.1:9222`
      ].join('\n');
      Object.assign(cfg, { command: 'sh', args: ['-c', sh] });
    }
    out[pl.id] = cfg;
  }
  return out;
}

// ---------- the main thing: run a bot ----------
export function runBot({ botId, thread, prompt, depth = 0, source = 'user', parentRun = null, quiet = false }) {
  botId = Number(botId);
  const run = q('INSERT INTO runs (bot_id, thread, prompt, status, parent_run) VALUES (?,?,?,?,?)').run(botId, thread, redact(prompt), 'queued', parentRun);
  const runId = Number(run.lastInsertRowid);
  if (!botStatus.get(botId) || botStatus.get(botId).state === 'idle') setStatus(botId, 'queued', 'Queued');
  const prev = queues.get(botId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => execute({ runId, botId, thread, prompt, depth, source, quiet }));
  queues.set(botId, next);
  return runId;
}

function execute({ runId, botId, thread, prompt, depth, source, quiet }) {
  return new Promise((resolve) => {
    const bot = parseBot(q('SELECT * FROM bots WHERE id=?').get(botId));
    const runRow = q('SELECT status FROM runs WHERE id=?').get(runId);
    if (!bot || runRow?.status === 'stopped') return resolve();
    const cwd = writeBotBrief(bot, computersOn() && !!bot.computer);
    const isRoom = thread.startsWith('room:');
    const roomId = isRoom ? Number(thread.slice(5)) : null;

    let fullPrompt = prompt;
    if (isRoom) fullPrompt = roomContext(roomId, bot) + `\nYour task now (from ${source}):\n${prompt}`;
    else if (source === 'schedule') fullPrompt = quiet
      ? `(Scheduled quiet check) ${prompt}\n\nThis is a quiet check: the user only wants to hear about problems. If everything is fine, reply with exactly ALL_CLEAR followed by one short line of key numbers (e.g. "ALL_CLEAR storage 41%, 11/11 guests up"). If anything needs attention, describe it normally and do not write ALL_CLEAR.`
      : `(Scheduled routine) ${prompt}`;

    const session = !isRoom && source !== 'schedule'
      ? q('SELECT session_id FROM sessions WHERE bot_id=? AND thread=?').get(botId, thread)?.session_id
      : null;

    const remote = computersOn() && !!bot.computer;
    const hookPath = remote ? '/opt/nimbus/approval-hook.js' : HOOK;
    const settings = {
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${hookPath}"`, timeout: 86400 }] }] }
    };
    const args = ['-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--effort', bot.effort || 'medium',
      '--settings', JSON.stringify(settings)];
    const mcp = mcpServers(botId, remote);
    if (Object.keys(mcp).length) args.push('--mcp-config', JSON.stringify({ mcpServers: mcp }));
    if (bot.model) args.push('--model', bot.model);
    if (session) args.push('--resume', session);

    q("UPDATE runs SET status='running', started_at=unixepoch(), effort=? WHERE id=?").run(bot.effort, runId);
    setStatus(botId, 'working', isRoom ? 'Working in a group chat' : 'Working…');

    const traceBody = { steps: [], status: 'running', effort: bot.effort, started: Date.now(), source };
    const traceMsg = addMessage(thread, botId, 'trace', traceBody, runId);
    liveTraces.set(runId, { msgId: traceMsg.id, body: traceBody });

    let stderr = '';
    const hookEnv = { NIMBUS_RUN_ID: String(runId), NIMBUS_HOOK_TOKEN: HOOK_TOKEN };
    const child = remote
      ? remoteRun(bot, cwd, runId, args, fullPrompt, { ...hookEnv, NIMBUS_URL: agentConfig().callback })
      : spawn(CLAUDE_BIN, args, {
        cwd,
        env: { ...process.env, ...hookEnv, NIMBUS_URL: `http://127.0.0.1:${process.env.PORT || 8787}` },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    procs.set(runId, child);
    // A failed launch (e.g. Claude Code not installed) must fail this run, not crash the server.
    // 'close' still fires afterwards and records the run as an error.
    child.on('error', (e) => {
      stderr += e.code === 'ENOENT'
        ? `Couldn't find Claude Code (tried "${CLAUDE_BIN}"). Install it, or set CLAUDE_BIN to the full path of claude.exe.`
        : e.message;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(fullPrompt);

    // The time limit counts working time only: time spent waiting for the user's approval doesn't count,
    // so a routine that needs an OK at 8:00 still finishes when it's approved at 9:30.
    const clock = { start: Date.now(), waited: 0, since: null };
    runClocks.set(runId, clock);
    const killer = setInterval(() => {
      const waiting = clock.since ? Date.now() - clock.since : 0;
      if (Date.now() - clock.start - clock.waited - waiting > RUN_TIMEOUT_MS) child.kill('SIGTERM');
    }, 15_000);
    const toolsById = new Map();
    let buf = '', finalText = null, isError = false, cost = 0, sessionId = null;

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'tool_use') {
              const step = { id: block.id, tool: block.name, text: summarizeTool(block.name, block.input), state: 'running' };
              toolsById.set(block.id, step);
              traceBody.steps.push(step);
              updateMessage(traceMsg.id, traceBody);
            } else if (block.type === 'text' && block.text?.trim()) {
              traceBody.lastThought = block.text.trim().slice(0, 300);
            }
          }
        } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'tool_result' && toolsById.has(block.tool_use_id)) {
              const step = toolsById.get(block.tool_use_id);
              const denied = block.is_error && /Nimbus: rejected/.test(JSON.stringify(block.content));
              step.state = denied ? 'rejected' : block.is_error ? 'error' : 'done';
              updateMessage(traceMsg.id, traceBody);
            }
          }
        } else if (ev.type === 'result') {
          finalText = ev.result ?? '';
          isError = !!ev.is_error;
          cost = ev.total_cost_usd || 0;
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-8000); });

    child.on('close', (code) => {
      clearInterval(killer); runClocks.delete(runId);
      procs.delete(runId);
      liveTraces.delete(runId);
      const stopped = traceBody.status === 'stopping';
      traceBody.status = stopped ? 'stopped' : (code === 0 && !isError ? 'done' : 'error');
      traceBody.ended = Date.now();
      traceBody.cost = cost;
      for (const s of traceBody.steps) if (s.state === 'running' || s.state === 'waiting') s.state = stopped ? 'stopped' : 'error';
      updateMessage(traceMsg.id, traceBody);

      q('UPDATE runs SET status=?, ended_at=unixepoch(), cost_usd=?, session_id=? WHERE id=?').run(traceBody.status, cost, sessionId, runId);
      if (sessionId && !isRoom && source !== 'schedule') {
        q('INSERT INTO sessions (bot_id, thread, session_id) VALUES (?,?,?) ON CONFLICT(bot_id, thread) DO UPDATE SET session_id=excluded.session_id').run(botId, thread, sessionId);
      }
      // Cancel any approval still waiting from this run.
      q("UPDATE approvals SET status='expired', decided_at=unixepoch() WHERE run_id=? AND status='pending'").run(runId);
      broadcast('approvals_changed', {});

      let reply = finalText;
      if (stopped) reply = reply || 'Stopped.';
      else if (reply == null || (code !== 0 && !reply)) {
        reply = `Something went wrong running Claude Code (exit ${code}).\n\n${stderr.trim().split('\n').slice(-6).join('\n') || 'No error output.'}`;
      }
      // Quiet checks that found nothing wrong are kept as a small note, without a notification.
      const allClear = quiet && !isError && code === 0 && /^\s*ALL_CLEAR\b/.test(reply);
      const msg = allClear
        ? addMessage(thread, botId, 'quiet', reply.replace(/^\s*ALL_CLEAR\b[\s:—-]*/, '').trim() || 'All clear', runId)
        : addMessage(thread, botId, isError || (code !== 0 && !stopped) ? 'error' : 'text', reply, runId);

      const stillQueued = q("SELECT COUNT(*) AS n FROM runs WHERE bot_id=? AND status='queued'").get(botId).n;
      setStatus(botId, stillQueued ? 'queued' : 'idle', stillQueued ? 'Queued' : 'Idle');

      // Group chat handoffs: bots @mentioning other bots wakes them up.
      if (isRoom && msg.kind === 'text' && depth < MAX_HANDOFF_DEPTH) {
        const room = q('SELECT * FROM rooms WHERE id=?').get(roomId);
        if (room?.bots_can_talk) {
          for (const target of findMentions(reply, roomMembers(roomId), botId)) {
            runBot({ botId: target.id, thread, prompt: `${bot.name} said: ${reply}`, depth: depth + 1, source: bot.name });
          }
        }
      }
      resolve();
    });
  });
}

export function stopRun(runId) {
  const child = procs.get(Number(runId));
  const t = liveTraces.get(Number(runId));
  if (t) t.body.status = 'stopping';
  if (child) { child.kill('SIGTERM'); return true; }
  q("UPDATE runs SET status='stopped' WHERE id=? AND status='queued'").run(runId);
  return false;
}

// On boot, anything left "running" from a previous process is dead.
export function recoverRuns() {
  q("UPDATE runs SET status='interrupted' WHERE status IN ('running','queued')").run();
  q("UPDATE approvals SET status='expired' WHERE status='pending'").run();
  for (const m of q("SELECT * FROM messages WHERE kind='trace' AND body LIKE '%\"status\":\"running\"%'").all()) {
    const body = JSON.parse(m.body);
    body.status = 'interrupted';
    for (const s of body.steps) if (s.state === 'running' || s.state === 'waiting') s.state = 'error';
    q('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(body), m.id);
  }
}
