// Bot sandbox: start Claude Code inside bubblewrap (bwrap) so the operating system, not a text filter,
// keeps a bot away from Nimbus's data. Inside the box a bot sees:
//   - its own folder (read and write) and its own Claude Code history
//   - Nimbus's helper tools (bin/, hooks/), Claude Code, ~/opt office tools, ~/.local: read-only
//   - the rest of the system read-only, with a private /tmp
// Hidden: the rest of the home folder (Nimbus code, data/, .env, keys, other bots, ~/.ssh, ~/.claude),
// /srv, and every other process (its own PID namespace, so no reading the server's environment).
//
// Setting "sandbox" (Server settings) or NIMBUS_SANDBOX: off (default) | all | bot ids, e.g. "4" or "1,4".
// "all,-7" = every bot (new ones too) except #7. Runs on bot computers aren't affected. Needs bwrap (apt install bubblewrap).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSetting } from './db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const BWRAP = process.env.NIMBUS_BWRAP || '/usr/bin/bwrap';
let available = null;
const bwrapWorks = () => {
  if (available === null) {
    try { execFileSync(BWRAP, ['--ro-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--dev', '/dev', 'true'], { timeout: 5000, stdio: 'ignore' }); available = true; }
    catch { available = false; console.error('Nimbus: bot sandbox is on but bwrap does not work here; bots run without it.'); }
  }
  return available;
};

export function sandboxed(botId) {
  const SETTING = String(getSetting('sandbox', 'NIMBUS_SANDBOX') || 'off').trim().toLowerCase();
  if (SETTING === 'off' || SETTING === '' || process.platform !== 'linux') return false;
  const list = SETTING.split(/[\s,]+/);
  if (list.includes('-' + botId)) return false; // "all,-7": every bot except #7
  const on = list.includes('all') || list.includes(String(botId));
  return on && bwrapWorks();
}

// Claude Code keeps each folder's conversations in ~/.claude/projects/<folder with every non-alphanumeric as ->.
const projectDir = (cwd) => path.join(HOME, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

// Returns [command, args] that run cmd/args inside the box. botDir is the bot's own folder (also the cwd).
export function wrap(cmd, args, botDir, { sharedLogin = false } = {}) {
  const own = path.resolve(botDir);
  const state = path.join(own, '.nimbus-sandbox');
  fs.mkdirSync(path.join(state, 'npm'), { recursive: true });
  const claudeJson = path.join(state, 'claude.json');
  if (!fs.existsSync(claudeJson)) fs.writeFileSync(claudeJson, JSON.stringify({ hasCompletedOnboarding: true }));
  const proj = projectDir(own);
  fs.mkdirSync(proj, { recursive: true });

  const b = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', '/srv',
    '--tmpfs', HOME];
  const ro = (p) => { if (fs.existsSync(p)) b.push('--ro-bind', p, p); };
  const rw = (p) => b.push('--bind', p, p);
  for (const p of ['.npm-global', '.local', 'opt', '.cache/ms-playwright', '.claude/plugins', '.claude/skills', '.claude/settings.json']) ro(path.join(HOME, p));
  ro(path.join(HERE, 'bin')); ro(path.join(HERE, 'hooks'));
  // Runs without a pasted Claude token use the server's login, so they need to read it.
  if (sharedLogin) ro(path.join(HOME, '.claude', '.credentials.json'));
  rw(own); rw(proj);
  b.push('--bind', claudeJson, path.join(HOME, '.claude.json'));
  b.push('--chdir', own, '--', cmd, ...args);
  return [BWRAP, b];
}

// Environment for a bot run: only what tools need, never the server's .env (secrets, passwords, …).
const KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'SHELL', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK'];
export function botEnv(extra, botDir, inBox) {
  const env = {};
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (inBox) env.npm_config_cache = path.join(path.resolve(botDir), '.nimbus-sandbox', 'npm');
  return { ...env, ...extra };
}
