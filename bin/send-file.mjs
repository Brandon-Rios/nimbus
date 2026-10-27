#!/usr/bin/env node
// Send a file from a bot into the chat it's working in (shown as a card with a preview and Download).
//   node send-file.mjs <path> ["caption"]
// Only works inside a Nimbus bot run (uses the run's NIMBUS_RUN_ID / NIMBUS_HOOK_TOKEN).
import path from 'node:path';
const [file, caption = ''] = process.argv.slice(2);
if (!file) { console.error('Usage: send-file.mjs <path> ["caption"]'); process.exit(2); }
const { NIMBUS_RUN_ID: runId, NIMBUS_HOOK_TOKEN: token, NIMBUS_URL: base = 'http://127.0.0.1:8787' } = process.env;
if (!runId || !token) { console.error('Not inside a Nimbus bot run.'); process.exit(2); }
const res = await fetch(`${base}/api/hook/send-file`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-nimbus-hook': token },
  body: JSON.stringify({ runId: Number(runId), path: path.resolve(file), caption })
});
const out = await res.json().catch(() => ({}));
if (!res.ok) { console.error('Couldn’t send: ' + (out.error || res.status)); process.exit(1); }
console.log(`Sent ${out.name} (${out.size} bytes) to the chat${out.preview ? ', with a preview' : ''}.`);
