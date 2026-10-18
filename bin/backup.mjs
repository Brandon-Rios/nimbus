#!/usr/bin/env node
// Encrypted backup of everything in data/ (bots, chats, memories, settings, uploads).
//   node bin/backup.mjs            make a backup now
//   node bin/backup.mjs --restore <file.tar.gz.enc> <empty folder>
// Backups go to ~/backups/nimbus (last 14 kept) and, if a target is set in Server settings
// ("user@host:/path"), are copied there with scp. The key is ~/opt/nimbus-backup.key: keep a copy
// off this server, since a backup can't be opened without it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '..', process.env.NIMBUS_DATA || 'data');
const OUT = path.join(os.homedir(), 'backups', 'nimbus');
const KEY = path.join(os.homedir(), 'opt', 'nimbus-backup.key');
const KEEP = 14;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();

if (process.argv[2] === '--restore') {
  const [file, dest] = process.argv.slice(3);
  if (!file || !dest) { console.error('Usage: backup.mjs --restore <backup.tar.gz.enc> <empty folder>'); process.exit(2); }
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('sh', ['-c', 'openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:"$1" -in "$2" | tar xz -C "$3"', 'sh', KEY, file, dest], { stdio: 'inherit' });
  console.log(`Restored into ${dest}. To use it: stop Nimbus, move it into place as data/, start Nimbus.`);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(KEY)) { fs.mkdirSync(path.dirname(KEY), { recursive: true }); fs.writeFileSync(KEY, sh('openssl', ['rand', '-hex', '32']).trim(), { mode: 0o600 }); }
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-backup-'));
const file = path.join(OUT, `nimbus-${stamp}.tar.gz.enc`);
try {
  // A consistent copy of the live database (VACUUM INTO is safe while Nimbus is running).
  const db = new DatabaseSync(path.join(DATA, 'nimbus.db'));
  db.exec(`VACUUM INTO '${path.join(work, 'nimbus.db').replace(/'/g, "''")}'`);
  db.close();
  execFileSync('sh', ['-c',
    'tar czf - --exclude=./nimbus.db --exclude=./nimbus.db-wal --exclude=./nimbus.db-shm -C "$1" . -C "$2" nimbus.db | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:"$3" -out "$4"',
    'sh', DATA, work, KEY, file]);
  fs.chmodSync(file, 0o600);
  const size = fs.statSync(file).size;
  // Keep the newest KEEP backups.
  const old = fs.readdirSync(OUT).filter((f) => /^nimbus-.*\.tar\.gz\.enc$/.test(f)).sort().reverse().slice(KEEP);
  for (const f of old) fs.rmSync(path.join(OUT, f));
  // Copy off this server if a target is configured.
  let remote = null;
  const target = (() => { try { const d = new DatabaseSync(path.join(DATA, 'nimbus.db'), { readOnly: true }); const v = d.prepare("SELECT value FROM settings WHERE key='backup_target'").get()?.value; d.close(); return v; } catch { return null; } })();
  if (target) {
    sh('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', file, target.replace(/\/?$/, '/')]);
    remote = target;
    // Prune old copies there too (same names, keep KEEP).
    const [host, dir] = target.split(':');
    try { sh('ssh', ['-o', 'BatchMode=yes', host, `cd "${dir}" && ls -1 nimbus-*.tar.gz.enc | sort -r | tail -n +${KEEP + 1} | xargs -r rm --`]); } catch {}
  }
  console.log(JSON.stringify({ ok: true, file, size, remote, at: Date.now() }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e.stderr || e.message).trim().slice(0, 300), at: Date.now() }));
  process.exitCode = 1;
} finally { fs.rmSync(work, { recursive: true, force: true }); }
