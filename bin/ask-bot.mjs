#!/usr/bin/env node
// For bots: message another Nimbus bot and (by default) wait for its answer.
//   node ask-bot.mjs "<bot name or #id>" "<message>"
//   node ask-bot.mjs --no-wait "<bot>" "<message>"
//   node ask-bot.mjs --result <run id>
// Works inside a Nimbus run, which provides NIMBUS_URL, NIMBUS_HOOK_TOKEN and NIMBUS_RUN_ID.
const { NIMBUS_URL, NIMBUS_HOOK_TOKEN, NIMBUS_RUN_ID } = process.env;
if (!NIMBUS_URL || !NIMBUS_HOOK_TOKEN || !NIMBUS_RUN_ID) { console.error('Run this from inside a Nimbus bot run.'); process.exit(2); }
const args = process.argv.slice(2);
const headers = { 'x-nimbus-hook': NIMBUS_HOOK_TOKEN, 'content-type': 'application/json' };
let res;
if (args[0] === '--result') {
  res = await fetch(`${NIMBUS_URL}/api/hook/ask/${Number(args[1])}`, { headers });
} else {
  const wait = args[0] !== '--no-wait';
  const [to, ...rest] = wait ? args : args.slice(1);
  if (!to || !rest.length) { console.error('Usage: ask-bot.mjs [--no-wait] "<bot name or #id>" "<message>"'); process.exit(2); }
  res = await fetch(`${NIMBUS_URL}/api/hook/ask`, { method: 'POST', headers, body: JSON.stringify({ fromRun: Number(NIMBUS_RUN_ID), to, text: rest.join(' '), wait }) });
}
const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
if (!res.ok || d.error === true || (typeof d.error === 'string')) { console.error(typeof d.error === 'string' ? d.error : `${d.to} hit an error:\n${d.reply}`); process.exit(1); }
if (d.queued) console.log(`Sent to ${d.to} (run ${d.runId}); not waiting for a reply.`);
else if (d.status === 'running') console.log(`${d.to || 'The bot'} is still working. ${d.note}`);
else console.log(`${d.to ? d.to + ' replied' : 'Reply'}:\n${d.reply}`);
