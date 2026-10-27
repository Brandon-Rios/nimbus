// Which Claude account the bots use. Either the server's own Claude Code login (~/.claude), or a token
// pasted in Nimbus (from `claude setup-token`), stored encrypted and passed to every run as
// CLAUDE_CODE_OAUTH_TOKEN. The token wins when both exist.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getSetting, setSetting } from './db.js';

const KEY_FILE = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const KEY = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
const seal = (text) => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
};
const unseal = (blob) => {
  const b = Buffer.from(String(blob).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};

export const TOKEN_RE = /^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/;
export function setClaudeToken(token) {
  setSetting('claude_token', token ? seal(token) : '');
  setSetting('claude_token_at', token ? String(Math.floor(Date.now() / 1000)) : '');
}
export function claudeToken() {
  const blob = getSetting('claude_token');
  if (!blob) return null;
  try { return unseal(blob); } catch { return null; }
}
// Extra environment for every Claude Code process.
export const claudeEnv = () => { const t = claudeToken(); return t ? { CLAUDE_CODE_OAUTH_TOKEN: t } : {}; };
export function claudeStatus() {
  if (claudeToken()) return { mode: 'token', at: Number(getSetting('claude_token_at')) || null };
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return { mode: fs.existsSync(path.join(home, '.credentials.json')) ? 'login' : 'none' };
}
