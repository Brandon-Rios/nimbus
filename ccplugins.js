// Claude Code plugins & skills, server-wide: every bot reads ~/.claude/plugins, ~/.claude/skills and
// ~/.claude/settings.json (sandboxed bots get them read-only), so installing here gives all bots the plugin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CLAUDE_BIN } from './runner.js';
import { DATA_DIR } from './db.js';

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills', 'synced');
const ID_RE = /^[A-Za-z0-9._-]{1,120}@[A-Za-z0-9._-]{1,120}$/;

function claude(args, timeout = 120_000) {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, args, { timeout, cwd: DATA_DIR, maxBuffer: 64 * 1024 * 1024 }, (err, out = '', errOut = '') => resolve({ err, out: String(out), errOut: String(errOut) }));
  });
}

// The full catalog is ~4,000 plugins and `claude plugin list --available` takes a few seconds: cache it.
let cache = { at: 0, data: null, loading: null };
function load() {
  if (cache.loading) return cache.loading;
  cache.loading = claude(['plugin', 'list', '--available', '--json']).then(({ out }) => {
    try {
      const d = JSON.parse(out);
      const installed = (d.installed || []).map((p) => ({ id: p.pluginId || p.id || `${p.name}@${p.marketplaceName || p.marketplace}`, name: p.name, version: p.version || '', enabled: p.enabled !== false, description: p.description || '' }));
      const available = (d.available || []).map((p) => ({ id: p.pluginId, name: p.name, description: (p.description || '').slice(0, 400), version: p.version || '',
        marketplace: p.marketplaceName, installs: p.installCount || 0 }));
      cache = { at: Date.now(), data: { installed, available }, loading: null };
    } catch { cache.loading = null; }
    return cache.data || { installed: [], available: [] };
  });
  return cache.loading;
}

// Skills synced from the claude.ai organization (read-only here; managed in the Claude admin console).
function orgSkills() {
  const out = [];
  try {
    for (const dir of fs.readdirSync(SKILLS_DIR)) {
      const mf = path.join(SKILLS_DIR, dir, 'manifest.json');
      if (!fs.existsSync(mf)) continue;
      for (const s of JSON.parse(fs.readFileSync(mf, 'utf8')).skills || []) out.push({ name: s.name || s.skillId, description: String(s.description || '').slice(0, 300) });
    }
  } catch {}
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function pluginCatalog(fresh) {
  const data = fresh || !cache.data ? await load() : (Date.now() - cache.at > 10 * 60_000 && load(), cache.data);
  return { ...data, skills: orgSkills() };
}

// Install/uninstall at user scope. No -y: a plugin that wants to run a marketplace-declared command
// is refused here (do that by hand after reading the command).
export async function setPlugin(id, install) {
  if (!ID_RE.test(String(id))) throw new Error('Bad plugin id');
  const r = await claude(['plugin', install ? 'install' : 'uninstall', id, '--json'], 300_000);
  let res = null;
  for (const line of r.out.trim().split('\n').reverse()) { try { res = JSON.parse(line); break; } catch {} }
  cache.at = 0; load();
  if (r.err) throw new Error(res?.error || res?.message || r.errOut.trim().split('\n').pop() || 'Plugin command failed');
  return res || { ok: true };
}
