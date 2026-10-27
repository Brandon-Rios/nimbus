#!/usr/bin/env node
// Live documents from inside a bot run. The user watches changes appear in the document pane.
//   doc.mjs create "<title>" [markdown file | -]   new doc (stdin with -); posts a card in the chat
//   doc.mjs list                                   your docs and this chat's docs
//   doc.mjs outline <doc>                          ids, types, hashes, first words (+ open comments)
//   doc.mjs read <doc> <blockId> [blockId…]        chosen blocks in full
//   doc.mjs since <doc> <rev>                      only what changed after a revision
//   doc.mjs full <doc>                             whole doc as Markdown (avoid on long docs)
//   doc.mjs ops <doc> <json | file | ->            apply operations: {"ifRev":N,"ops":[…]}
//   doc.mjs comment <doc> '<json>'                 {"blockId","quote","body"} or {"parent":id,"body"} or {"resolve":id}
//   doc.mjs export <doc> docx|pdf|md ["caption"]   send the doc to the chat as a file
import fs from 'node:fs';
const { NIMBUS_RUN_ID: runId, NIMBUS_HOOK_TOKEN: token, NIMBUS_URL: base = 'http://127.0.0.1:8787' } = process.env;
const [cmd, ...a] = process.argv.slice(2);
const usage = () => { console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(2); };
if (!cmd) usage();
if (!runId || !token) { console.error('Not inside a Nimbus bot run.'); process.exit(2); }
const input = (x) => (x === '-' ? fs.readFileSync(0, 'utf8') : x && fs.existsSync(x) ? fs.readFileSync(x, 'utf8') : x);
async function call(p, payload = {}) {
  const res = await fetch(base + '/api/hook/docs' + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nimbus-hook': token }, body: JSON.stringify({ runId: Number(runId), ...payload }) });
  const out = await res.json().catch(() => ({}));
  console.log(JSON.stringify(out, null, 1));
  process.exit(res.ok ? 0 : 1);
}
const id = a[0];
switch (cmd) {
  case 'create': await call('', { title: a[0], markdown: input(a[1]) || '' }); break;
  case 'list': await call('/list'); break;
  case 'outline': await call(`/${id}/read`, { view: 'outline' }); break;
  case 'read': await call(`/${id}/read`, { view: 'blocks', blocks: a.slice(1) }); break;
  case 'since': await call(`/${id}/read`, { view: 'since', since: Number(a[1]) }); break;
  case 'full': await call(`/${id}/read`, { view: 'full' }); break;
  case 'ops': await call(`/${id}/ops`, JSON.parse(input(a[1]))); break;
  case 'comment': await call(`/${id}/comment`, JSON.parse(input(a[1]))); break;
  case 'export': await call(`/${id}/export`, { format: a[1] || 'docx', caption: a[2] || '' }); break;
  default: usage();
}
