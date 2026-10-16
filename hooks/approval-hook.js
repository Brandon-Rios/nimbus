#!/usr/bin/env node
// Claude Code PreToolUse hook. Nimbus passes this to every bot run.
// It asks the Nimbus server whether the tool call needs the user's approval,
// and if so, waits (as long as it takes) until the user taps Approve or Reject.

const url = process.env.NIMBUS_URL;
const runId = process.env.NIMBUS_RUN_ID;
const token = process.env.NIMBUS_HOOK_TOKEN;

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', main);

function out(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason }
  }));
  process.exit(0);
}

async function call(path, body) {
  const res = await fetch(url + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-nimbus-hook': token },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!url || !runId) process.exit(0); // not a Nimbus run: do nothing
  let input = {};
  try { input = JSON.parse(raw); } catch {}

  let first;
  for (let i = 0; ; i++) {
    try { first = await call('/api/hook/pretool', { runId, tool: input.tool_name, input: input.tool_input }); break; }
    catch { if (i > 20) out('deny', 'Nimbus server unreachable, so the approval check failed. Try again later.'); await sleep(3000); }
  }
  if (first.decision === 'allow') process.exit(0); // not gated

  // Gated: long-poll until the user decides.
  for (;;) {
    let r;
    try { r = await call(`/api/hook/approval/${first.approvalId}`); }
    catch { await sleep(3000); continue; }
    if (r.status === 'approved') out('allow', 'Approved by the user in Nimbus.');
    if (r.status === 'rejected') out('deny', `Nimbus: rejected by the user.${r.note ? ' Their note: ' + r.note : ''} Do not retry the same action; adjust or ask.`);
    if (r.status === 'expired') out('deny', 'Nimbus: approval expired.');
  }
}
