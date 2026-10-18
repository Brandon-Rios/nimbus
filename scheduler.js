// Minimal 5-field cron: "min hour day-of-month month day-of-week".
// Supports *, numbers, ranges (1-5), lists (1,3,5) and steps (*/15, 9-17/2).
import { q } from './db.js';
import { runBot, addMessage } from './runner.js';
import { getPlanUsage } from './planusage.js';

function fieldMatches(field, value, min, max) {
  return field.split(',').some((part) => {
    let [range, step] = part.split('/');
    step = step ? Number(step) : 1;
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) [lo, hi] = range.split('-').map(Number);
    else { lo = hi = Number(range); if (part.includes('/')) hi = max; }
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

export function cronMatches(expr, d) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [mi, h, dom, mon, dow] = f;
  const dowVal = d.getDay();
  const domOk = fieldMatches(dom, d.getDate(), 1, 31);
  const dowOk = fieldMatches(dow, dowVal, 0, 7) || (dowVal === 0 && fieldMatches(dow, 7, 0, 7));
  const dayOk = dom !== '*' && dow !== '*' ? domOk || dowOk : domOk && dowOk;
  return fieldMatches(mi, d.getMinutes(), 0, 59) && fieldMatches(h, d.getHours(), 0, 23) && fieldMatches(mon, d.getMonth() + 1, 1, 12) && dayOk;
}

export function isValidCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  return f.length === 5 && f.every((x) => /^[\d*,\-/]+$/.test(x));
}

export function nextRun(expr, from = new Date()) {
  if (!isValidCron(expr)) return null;
  const d = new Date(from);
  d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 8; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(expr, d)) return d;
  }
  return null;
}

const GUARD_PCT = Number(process.env.NIMBUS_ROUTINE_GUARD_PCT || 85);

export function startScheduler() {
  let lastMinute = -1;
  setInterval(async () => {
    const now = new Date();
    const stamp = Math.floor(now.getTime() / 60000);
    if (stamp === lastMinute) return;
    lastMinute = stamp;
    const due = q('SELECT * FROM routines WHERE enabled=1').all().filter((r) => cronMatches(r.cron, now));
    if (!due.length) return;
    // Guardrail: when the plan's 5-hour limit is nearly used up, skip routines so it's left for you.
    const plan = await getPlanUsage();
    const fiveHour = plan.ok ? plan.windows.find((w) => w.label === '5-hour limit')?.used : null;
    for (const r of due) {
      q('UPDATE routines SET last_run=unixepoch() WHERE id=?').run(r.id);
      if (fiveHour != null && fiveHour >= GUARD_PCT) {
        addMessage('bot:' + r.bot_id, 'system', 'note', `Skipped a scheduled routine: your Claude plan's 5-hour limit is ${Math.round(fiveHour)}% used (guardrail: ${GUARD_PCT}%).`);
        continue;
      }
      runBot({ botId: r.bot_id, thread: 'bot:' + r.bot_id, prompt: r.prompt, source: 'schedule', quiet: !!r.quiet });
    }
  }, 15000).unref();
}
