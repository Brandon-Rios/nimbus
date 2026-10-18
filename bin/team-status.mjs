#!/usr/bin/env node
// A plain-text summary of the Nimbus team for the last N hours (default 24), for briefings:
// runs and failures per bot, quiet-check results, approvals waiting, plan usage and the last backup.
//   node bin/team-status.mjs [hours]
// Runs on the Nimbus server (uses data/admin.token).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '..', process.env.NIMBUS_DATA || 'data');
const token = fs.readFileSync(path.join(DATA, 'admin.token'), 'utf8').trim();
const get = (p) => fetch(`http://127.0.0.1:${process.env.PORT || 8787}${p}`, { headers: { 'x-nimbus-admin': token } }).then((r) => r.json());
const hours = Number(process.argv[2] || 24);
const since = Date.now() / 1000 - hours * 3600;

const [state, act, plan, backup] = await Promise.all([get('/api/state'), get('/api/activity?days=' + Math.ceil(hours / 24)), get('/api/plan-usage'), get('/api/backup')]);
const name = (id) => state.bots.find((b) => b.id === id)?.name || `Bot ${id}`;
const runs = act.runs.filter((r) => r.started_at >= since);
const out = [`Nimbus team status, last ${hours} h (${new Date().toLocaleString()})`, ''];

out.push('Bots:');
for (const b of state.bots) {
  const mine = runs.filter((r) => r.bot_id === b.id);
  const failed = mine.filter((r) => ['error', 'interrupted'].includes(r.status)).length;
  out.push(`- ${b.name}: ${mine.length} runs${failed ? `, ${failed} FAILED` : ''}, now ${b.status.label}`);
}
// The latest quiet-check / routine outcome per bot comes from its chat's last messages.
const checks = [];
for (const b of state.bots) {
  const msgs = await get(`/api/threads/${encodeURIComponent('bot:' + b.id)}/messages`);
  const last = [...msgs].reverse().find((m) => m.created_at >= since && (m.kind === 'quiet' || (m.kind === 'text' && String(m.author) === String(b.id) && act.runs.some((r) => r.id === m.run_id && /^\(Scheduled/.test(r.prompt)))));
  if (last) checks.push(`- ${b.name}: ${last.kind === 'quiet' ? 'all clear, ' + last.body : 'NEEDS ATTENTION: ' + last.body.replace(/\s+/g, ' ').slice(0, 300)}`);
}
if (checks.length) out.push('', 'Scheduled checks:', ...checks);
out.push('', `Approvals waiting: ${state.approvals.length}${state.approvals.length ? ' (' + state.approvals.map((a) => `${name(a.bot_id)}: ${a.tool}`).join('; ') + ')' : ''}`);
if (plan.ok) out.push(`Claude plan: ${plan.windows.map((w) => `${w.label} ${Math.round(w.used)}% used`).join(', ')}`);
const bk = backup.last;
out.push(`Last backup: ${!bk ? 'none yet' : bk.ok ? `${new Date(bk.at).toLocaleString()}, ${(bk.size / 1e6).toFixed(0)} MB${bk.remote ? ', copied off-server' : ', on the Nimbus server only'}` : 'FAILED: ' + bk.error}`);
console.log(out.join('\n'));
