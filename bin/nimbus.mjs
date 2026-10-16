#!/usr/bin/env node
// Talk to the local Nimbus API from this server, without logging in:
//   node bin/nimbus.mjs GET /api/state
//   node bin/nimbus.mjs POST /api/bots '{"name":"Helper","role":"..."}'
//   node bin/nimbus.mjs PATCH /api/bots/4 '{"effort":"high"}'
// Uses data/admin.token, which Nimbus creates on start.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '..', process.env.NIMBUS_DATA || 'data');
const [method = 'GET', apiPath = '/api/state', body] = process.argv.slice(2);
const token = fs.readFileSync(path.join(DATA, 'admin.token'), 'utf8').trim();
const res = await fetch(`http://127.0.0.1:${process.env.PORT || 8787}${apiPath}`, {
  method: method.toUpperCase(),
  headers: { 'x-nimbus-admin': token, 'content-type': 'application/json' },
  body: body || undefined
});
const text = await res.text();
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
process.exit(res.ok ? 0 : 1);
