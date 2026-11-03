// Claude plan usage: the same numbers as Claude Code's /usage (% of the 5-hour and weekly limits used),
// from Anthropic's OAuth usage endpoint with the login Claude Code keeps in ~/.claude/.credentials.json.
// The endpoint isn't a documented API, so callers treat failures as "unknown".
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let planCache = null; // { at, data }
export async function getPlanUsage() {
  if (planCache && Date.now() - planCache.at < 60_000) return planCache.data;
  let data;
  try {
    const home = process.env.HOME || os.homedir();
    const cred = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth || {};
    if (!cred.accessToken) throw new Error('Claude Code isn’t logged in with a Claude plan');
    if (cred.expiresAt && cred.expiresAt < Date.now()) throw new Error('Claude login token expired; it refreshes on the next bot run');
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-code/2 (nimbus)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`Usage check failed (${r.status})`);
    const u = await r.json();
    const win = (w, label) => (w && typeof w.utilization === 'number' ? { label, used: w.utilization, resets: w.resets_at } : null);
    data = { ok: true, plan: cred.subscriptionType || '', windows: [win(u.five_hour, '5-hour limit'), win(u.seven_day, 'Weekly limit'),
      win(u.seven_day_opus, 'Weekly Opus'), win(u.seven_day_sonnet, 'Weekly Sonnet')].filter(Boolean) };
  } catch (e) { data = { ok: false, error: e.message }; }
  planCache = { at: Date.now(), data };
  return data;
}

// Models the Claude login can use (the same OAuth token works with /v1/models), for the bot model picker.
const modelCaches = new Map(); // token (or '') -> { at, data }
export async function getModels(token = null) {
  const key = token || '';
  const hit = modelCaches.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  let data;
  try {
    const home = process.env.HOME || os.homedir();
    const accessToken = token || JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken;
    if (!accessToken) throw new Error('Claude Code isn’t logged in with a Claude plan');
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'user-agent': 'claude-code/2 (nimbus)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`Model list failed (${r.status})`);
    const u = await r.json();
    data = { ok: true, models: (u.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id })) };
  } catch (e) { data = { ok: false, error: e.message, models: [] }; }
  if (data.ok) modelCaches.set(key, { at: Date.now(), data });
  return data;
}
