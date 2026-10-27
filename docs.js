// Live documents: a block editor that people and bots edit together.
//
// A document is an ordered list of blocks. Every block has a stable id (never changes, even when its text
// is edited), a type, Markdown content, and a short content hash. Every committed change bumps the
// document's revision. Bots never rewrite a whole document: they send operations (replace / insert /
// delete / move) that name block ids or quoted text, guarded by the hash (and revision) they last saw.
// If a person changed that block in the meantime the operation is refused with guard_mismatch and the
// block's current state, so the person's edit always wins. All operations in one call apply together or
// not at all. Every revision keeps a snapshot, so any version can be restored.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { db, q } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled', bot_id INTEGER, thread TEXT, owner_id INTEGER,
  rev INTEGER NOT NULL DEFAULT 0, created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS doc_blocks (
  doc_id TEXT NOT NULL, id TEXT NOT NULL, pos INTEGER NOT NULL, type TEXT NOT NULL, attrs TEXT DEFAULT '{}',
  md TEXT DEFAULT '', hash TEXT, rev INTEGER DEFAULT 0, PRIMARY KEY (doc_id, id)
);
CREATE TABLE IF NOT EXISTS doc_versions (
  doc_id TEXT NOT NULL, rev INTEGER NOT NULL, at INTEGER DEFAULT (unixepoch()), actor TEXT, summary TEXT,
  changed TEXT DEFAULT '[]', deleted TEXT DEFAULT '[]', snapshot TEXT, PRIMARY KEY (doc_id, rev)
);
CREATE TABLE IF NOT EXISTS doc_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, block_id TEXT, quote TEXT DEFAULT '', body TEXT NOT NULL,
  author TEXT NOT NULL, parent INTEGER, resolved INTEGER DEFAULT 0, created_at INTEGER DEFAULT (unixepoch())
);
`);

export class DocError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const LIMITS = { opsPerCall: 50, opBytes: 100_000, blocks: 2000, versions: 300 };
const newId = () => 'b_' + crypto.randomBytes(3).toString('hex');
const hashOf = (b) => crypto.createHash('sha1').update(`${b.type}\n${JSON.stringify(b.attrs || {})}\n${b.md}`).digest('hex').slice(0, 8);

// ---------- Markdown <-> blocks ----------
// One block per heading, paragraph, list, table, quote, code fence, divider, chart or pending section.
// Pending blocks are written as <!-- pending: intent -->, charts as ```chart (SVG or HTML) fences.
export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const push = (type, md, attrs = {}) => out.push({ type, md, attrs });
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^```\s*([\w-]*)/))) {
      const lang = m[1].toLowerCase(), body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      if (['chart', 'svg', 'diagram'].includes(lang)) push('chart', body.join('\n'));
      else push('code', body.join('\n'), lang ? { lang } : {});
      continue;
    }
    if ((m = line.match(/^<!--\s*pending:\s*(.*?)\s*-->\s*$/i))) { push('pending', '', { intent: m[1] }); i++; continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { push('heading', m[2].trim(), { level: m[1].length }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { push('divider', ''); i++; continue; }
    const take = (re) => { const body = []; while (i < lines.length && re.test(lines[i])) body.push(lines[i++]); return body.join('\n'); };
    if (/^\s*\|/.test(line)) { push('table', take(/^\s*\|/)); continue; }
    if (/^\s*>/.test(line)) { push('quote', take(/^\s*>/).replace(/^\s*> ?/gm, '')); continue; }
    if (/^\s*[-*+] \[[ xX]\] /.test(line)) { push('todo', take(/^(\s*[-*+] \[[ xX]\] |\s{2,}\S)/)); continue; }
    if (/^\s*[-*+] /.test(line)) { push('bullets', take(/^(\s*[-*+] |\s{2,}\S)/)); continue; }
    if (/^\s*\d+[.)] /.test(line)) { push('numbered', take(/^(\s*\d+[.)] |\s{2,}\S)/)); continue; }
    const body = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*>|\s*[-*+] |\s*\d+[.)] |<!--\s*pending:)/i.test(lines[i])) body.push(lines[i++]);
    if (!body.length) body.push(lines[i++]);
    push('paragraph', body.join('\n'));
  }
  return out;
}
export function blockToMarkdown(b) {
  const a = b.attrs || {};
  switch (b.type) {
    case 'heading': return '#'.repeat(a.level || 2) + ' ' + b.md;
    case 'quote': return b.md.split('\n').map((l) => '> ' + l).join('\n');
    case 'code': return '```' + (a.lang || '') + '\n' + b.md + '\n```';
    case 'chart': return '```chart\n' + b.md + '\n```';
    case 'divider': return '---';
    case 'pending': return `<!-- pending: ${a.intent || ''} -->`;
    default: return b.md;
  }
}
export const docMarkdown = (doc, blocks) => `# ${doc.title}\n\n` + blocks.map(blockToMarkdown).join('\n\n') + '\n';

// ---------- reading ----------
const parse = (r) => r && ({ id: r.id, type: r.type, attrs: JSON.parse(r.attrs || '{}'), md: r.md, hash: r.hash, rev: r.rev });
export const getDoc = (id) => q('SELECT * FROM docs WHERE id=?').get(String(id)) || null;
export const getBlocks = (docId) => q('SELECT * FROM doc_blocks WHERE doc_id=? ORDER BY pos').all(docId).map(parse);
const preview = (b) => (b.type === 'pending' ? `(pending) ${b.attrs.intent || ''}` : b.type === 'chart' ? '(chart)' : b.md.replace(/\s+/g, ' ')).slice(0, 60);
const brief = (b) => ({ id: b.id, type: b.type, ...(b.type === 'heading' ? { level: b.attrs.level } : {}), hash: b.hash, preview: preview(b) });

// The three cheap projections for bots: outline, chosen blocks in full, or only what changed since a revision.
export function readDoc(docId, { view = 'outline', blocks: ids = [], since = 0 } = {}) {
  const doc = getDoc(docId);
  if (!doc) throw new DocError('not_found', 'No such document');
  const all = getBlocks(docId);
  const head = { id: doc.id, title: doc.title, rev: doc.rev };
  if (view === 'outline') return { ...head, blocks: all.map(brief) };
  if (view === 'blocks') {
    const want = new Set(ids);
    return { ...head, blocks: all.filter((b) => want.has(b.id)).map((b) => ({ ...brief(b), markdown: blockToMarkdown(b), attrs: b.attrs })) };
  }
  if (view === 'since') {
    const rows = q('SELECT changed, deleted FROM doc_versions WHERE doc_id=? AND rev>? ORDER BY rev').all(docId, Number(since));
    const changed = new Set(), deleted = new Set();
    for (const r of rows) { JSON.parse(r.changed).forEach((x) => changed.add(x)); JSON.parse(r.deleted).forEach((x) => deleted.add(x)); }
    const order = all.map((b) => b.id);
    return { ...head, since: Number(since), changed: all.filter((b) => changed.has(b.id)).map((b) => ({ ...brief(b), after: order[order.indexOf(b.id) - 1] || null, markdown: blockToMarkdown(b) })),
      deleted: [...deleted].filter((x) => !order.includes(x)) };
  }
  if (view === 'full') return { ...head, markdown: docMarkdown(doc, all) };
  throw new DocError('bad_request', 'view must be outline, blocks, since or full');
}

// ---------- writing ----------
function snapshotOf(docId) { return JSON.stringify(getBlocks(docId).map(({ id, type, attrs, md }) => ({ id, type, attrs, md }))); }
function writeBlocks(docId, list, rev, touched) {
  // Renumber positions and save the blocks that changed (touched = ids whose content changed this commit).
  q('DELETE FROM doc_blocks WHERE doc_id=?').run(docId);
  const ins = q('INSERT INTO doc_blocks (doc_id, id, pos, type, attrs, md, hash, rev) VALUES (?,?,?,?,?,?,?,?)');
  list.forEach((b, i) => {
    const hash = hashOf(b);
    ins.run(docId, b.id, i, b.type, JSON.stringify(b.attrs || {}), b.md || '', hash, touched.has(b.id) ? rev : (b.rev || 0));
    b.hash = hash;
  });
}

export function createDoc({ title = 'Untitled', markdown = '', botId = null, thread = null, ownerId = null, actor = 'user' }) {
  const id = 'd_' + crypto.randomBytes(5).toString('hex');
  let src = String(markdown || '');
  const t = src.match(/^#\s+(.+)\n?/);
  if (t && !title) title = t[1].trim();
  if (t && t[1].trim() === String(title).trim()) src = src.slice(t[0].length); // the title isn't a block
  q('INSERT INTO docs (id, title, bot_id, thread, owner_id, rev) VALUES (?,?,?,?,?,1)').run(id, String(title).slice(0, 200) || 'Untitled', botId, thread, ownerId);
  const blocks = parseMarkdown(src).map((b) => ({ ...b, id: newId() }));
  writeBlocks(id, blocks, 1, new Set(blocks.map((b) => b.id)));
  q('INSERT INTO doc_versions (doc_id, rev, actor, summary, changed, snapshot) VALUES (?,?,?,?,?,?)')
    .run(id, 1, actor, 'Created', JSON.stringify(blocks.map((b) => b.id)), snapshotOf(id));
  return { id, rev: 1, blocks: blocks.map(brief) };
}

// Find the blocks an op points at: { blocks: [ids] } or { find: "quoted text" } (must match exactly one block).
function resolveTarget(list, target, opIndex) {
  if (!target) throw new DocError('bad_request', `op ${opIndex}: target is required`);
  if (Array.isArray(target.blocks) && target.blocks.length) {
    return target.blocks.map((id) => {
      const i = list.findIndex((b) => b.id === id);
      if (i < 0) throw new DocError('not_found', `op ${opIndex}: no block ${id}`, { block: id });
      return i;
    });
  }
  if (typeof target.find === 'string' && target.find) {
    const hits = list.map((b, i) => (b.md.includes(target.find) ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) throw new DocError(hits.length ? 'ambiguous' : 'not_found', `op ${opIndex}: "${target.find.slice(0, 40)}" is in ${hits.length} blocks; it must be in exactly one`);
    return hits;
  }
  if (target.at === 'start' || target.at === 'end') return [target.at === 'start' ? -1 : list.length - 1];
  throw new DocError('bad_request', `op ${opIndex}: target needs blocks, find, or at`);
}
const blocksFrom = (src) => {
  if (src?.markdown != null) return parseMarkdown(src.markdown);
  if (src?.text != null) return [{ type: 'paragraph', md: String(src.text), attrs: {} }];
  if (src?.block) return [{ type: src.block.type || 'paragraph', md: String(src.block.md || ''), attrs: src.block.attrs || {} }];
  throw new DocError('bad_request', 'with/source needs markdown, text or block');
};

// Apply operations atomically. ifRev: refuse if a targeted block changed after that revision.
// ifHash (per op): refuse if the target block's content isn't what the caller last saw.
export function applyOps(docId, { ifRev = null, ops = [], title = null } = {}, actor = 'user') {
  const doc = getDoc(docId);
  if (!doc) throw new DocError('not_found', 'No such document');
  if (!Array.isArray(ops) || ops.length > LIMITS.opsPerCall) throw new DocError('too_large', `Send 1 to ${LIMITS.opsPerCall} ops per call`);
  if (JSON.stringify(ops).length > LIMITS.opBytes * 5) throw new DocError('too_large', 'Operations are too large');
  const list = getBlocks(docId);
  const before = new Map(list.map((b) => [b.id, b]));
  const touched = new Set(), deleted = new Set(), created = [];
  const guard = (b, op, i) => {
    if (op.ifHash && b.hash !== op.ifHash) throw new DocError('guard_mismatch', `op ${i}: block ${b.id} changed since you read it`, { block: { ...brief(b), markdown: blockToMarkdown(b) } });
    if (ifRev != null && (before.get(b.id)?.rev || 0) > Number(ifRev)) throw new DocError('guard_mismatch', `op ${i}: block ${b.id} changed after revision ${ifRev}`, { block: { ...brief(b), markdown: blockToMarkdown(b) } });
  };
  ops.forEach((op, i) => {
    if (JSON.stringify(op).length > LIMITS.opBytes) throw new DocError('too_large', `op ${i} is over ${LIMITS.opBytes / 1000} KB`);
    switch (op.op) {
      case 'replace': {
        const idx = resolveTarget(list, op.target, i);
        idx.forEach((k) => guard(list[k], op, i));
        if (op.target.find && op.with?.text != null) { // replace just the quoted text, inside its block
          const b = list[idx[0]];
          b.md = b.md.replace(op.target.find, String(op.with.text));
          touched.add(b.id);
          break;
        }
        const fresh = blocksFrom(op.with);
        // The first new block keeps the first target's id, so links and comments to it survive.
        const first = idx[0];
        idx.slice(1).sort((x, y) => y - x).forEach((k) => { deleted.add(list[k].id); list.splice(k, 1); });
        const keep = list[first].id;
        const made = fresh.map((b, n) => ({ ...b, id: n === 0 ? keep : newId() }));
        list.splice(first, 1, ...made);
        made.forEach((b, n) => { touched.add(b.id); if (n) created.push(b.id); });
        if (!made.length) { deleted.add(keep); }
        break;
      }
      case 'insert': {
        const [k] = resolveTarget(list, op.target, i);
        if (k >= 0 && op.target.blocks) guard(list[k], op, i);
        const made = blocksFrom(op.source).map((b) => ({ ...b, id: newId() }));
        const at = op.target.at === 'start' ? 0 : op.target.at === 'end' ? list.length : op.side === 'before' ? k : k + 1;
        list.splice(at, 0, ...made);
        made.forEach((b) => { touched.add(b.id); created.push(b.id); });
        break;
      }
      case 'delete': {
        const idx = resolveTarget(list, op.target, i);
        idx.forEach((k) => guard(list[k], op, i));
        idx.sort((x, y) => y - x).forEach((k) => { deleted.add(list[k].id); list.splice(k, 1); });
        break;
      }
      case 'move': {
        const idx = resolveTarget(list, op.target, i);
        const moving = idx.sort((x, y) => x - y).map((k) => list[k]);
        idx.sort((x, y) => y - x).forEach((k) => list.splice(k, 1));
        const ref = op.ref ? list.findIndex((b) => b.id === op.ref) : (op.side === 'start' ? -1 : list.length - 1);
        if (op.ref && ref < 0) throw new DocError('not_found', `op ${i}: no block ${op.ref}`);
        list.splice(op.side === 'before' ? ref : ref + 1, 0, ...moving);
        moving.forEach((b) => touched.add(b.id));
        break;
      }
      case 'set': { // change a block's type/attrs (e.g. heading level, todo checked) without touching its text
        const [k] = resolveTarget(list, op.target, i);
        guard(list[k], op, i);
        if (op.type) list[k].type = String(op.type);
        if (op.attrs) list[k].attrs = { ...list[k].attrs, ...op.attrs };
        touched.add(list[k].id);
        break;
      }
      default: throw new DocError('bad_request', `op ${i}: unknown op "${op.op}" (use replace, insert, delete, move, set)`);
    }
  });
  if (list.length > LIMITS.blocks) throw new DocError('too_large', `Documents can have up to ${LIMITS.blocks} blocks`);
  for (const id of deleted) touched.delete(id);
  const rev = doc.rev + 1;
  db.exec('BEGIN');
  try {
    writeBlocks(docId, list, rev, touched);
    if (title != null) q('UPDATE docs SET title=? WHERE id=?').run(String(title).slice(0, 200) || 'Untitled', docId);
    q('UPDATE docs SET rev=?, updated_at=unixepoch() WHERE id=?').run(rev, docId);
    const summary = summarize(ops, title);
    q('INSERT INTO doc_versions (doc_id, rev, actor, summary, changed, deleted, snapshot) VALUES (?,?,?,?,?,?,?)')
      .run(docId, rev, actor, summary, JSON.stringify([...touched]), JSON.stringify([...deleted]), JSON.stringify({ title: title ?? doc.title, blocks: JSON.parse(snapshotOf(docId)) }));
    q('DELETE FROM doc_versions WHERE doc_id=? AND rev <= ? AND rev > 1').run(docId, rev - LIMITS.versions);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const now = new Map(getBlocks(docId).map((b) => [b.id, b]));
  return { rev, blocks: [...touched].filter((id) => now.has(id)).map((id) => brief(now.get(id))), created, deleted: [...deleted] };
}
function summarize(ops, title) {
  const n = (k) => ops.filter((o) => o.op === k).length;
  const parts = [['replace', 'edited'], ['insert', 'added'], ['delete', 'deleted'], ['move', 'moved'], ['set', 'changed']].filter(([k]) => n(k)).map(([k, w]) => `${w} ${n(k)}`);
  if (title != null) parts.unshift('renamed');
  return parts.join(', ') || 'no change';
}

export function setTitle(docId, title, actor) { return applyOps(docId, { ops: [], title }, actor); }

export function listVersions(docId) {
  return q('SELECT rev, at, actor, summary FROM doc_versions WHERE doc_id=? ORDER BY rev DESC LIMIT 100').all(docId);
}
export function restoreVersion(docId, rev, actor) {
  const v = q('SELECT snapshot FROM doc_versions WHERE doc_id=? AND rev=?').get(docId, Number(rev));
  if (!v) throw new DocError('not_found', 'That version is gone');
  const snap = JSON.parse(v.snapshot);
  const blocks = Array.isArray(snap) ? snap : snap.blocks;
  const doc = getDoc(docId), next = doc.rev + 1, old = new Set(getBlocks(docId).map((b) => b.id));
  db.exec('BEGIN');
  try {
    writeBlocks(docId, blocks, next, new Set(blocks.map((b) => b.id)));
    if (!Array.isArray(snap) && snap.title) q('UPDATE docs SET title=? WHERE id=?').run(snap.title, docId);
    q('UPDATE docs SET rev=?, updated_at=unixepoch() WHERE id=?').run(next, docId);
    q('INSERT INTO doc_versions (doc_id, rev, actor, summary, changed, deleted, snapshot) VALUES (?,?,?,?,?,?,?)')
      .run(docId, next, actor, `restored version ${rev}`, JSON.stringify(blocks.map((b) => b.id)), JSON.stringify([...old].filter((id) => !blocks.some((b) => b.id === id))), JSON.stringify({ title: getDoc(docId).title, blocks }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { rev: next };
}

// ---------- comments ----------
// Anchored to a block id plus the quoted words, so they survive edits elsewhere; if the words disappear
// from the block the comment is shown as detached rather than lost.
export function listComments(docId) {
  const blocks = new Map(getBlocks(docId).map((b) => [b.id, b]));
  return q('SELECT * FROM doc_comments WHERE doc_id=? ORDER BY id').all(docId).map((c) => ({ ...c, detached: !blocks.has(c.block_id) || (c.quote && !blocks.get(c.block_id).md.includes(c.quote)) }));
}
export function addComment(docId, { blockId = null, quote = '', body, parent = null }, author) {
  if (!String(body || '').trim()) throw new DocError('bad_request', 'Comment is empty');
  const r = q('INSERT INTO doc_comments (doc_id, block_id, quote, body, author, parent) VALUES (?,?,?,?,?,?)')
    .run(docId, blockId, String(quote).slice(0, 500), String(body).slice(0, 5000), author, parent);
  return { id: Number(r.lastInsertRowid) };
}
export const resolveComment = (docId, id, resolved = true) => q('UPDATE doc_comments SET resolved=? WHERE doc_id=? AND id=?').run(resolved ? 1 : 0, docId, Number(id));

// ---------- export ----------
// Markdown directly; Word through pandoc; PDF through pandoc → docx → LibreOffice (no LaTeX needed).
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120_000, ...opts }, (err, so, se) => (err ? reject(new Error(String(se || err.message).trim().split('\n').pop())) : resolve())));
export async function exportDoc(docId, format) {
  const doc = getDoc(docId);
  if (!doc) throw new DocError('not_found', 'No such document');
  const blocks = getBlocks(docId).filter((b) => b.type !== 'pending' && b.type !== 'chart');
  const mdText = `---\ntitle: "${doc.title.replace(/"/g, '\\"')}"\n---\n\n` + blocks.map(blockToMarkdown).join('\n\n') + '\n';
  const safe = doc.title.replace(/[\/:*?"<>|\x00-\x1f]+/g, '').replace(/\.+$/, '').trim().slice(0, 80) || 'document';
  if (format === 'md') return { name: safe + '.md', type: 'text/markdown', buf: Buffer.from(docMarkdown(doc, blocks)) };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-doc-'));
  try {
    fs.writeFileSync(path.join(tmp, 'doc.md'), mdText);
    await run('pandoc', ['doc.md', '-f', 'gfm+yaml_metadata_block+task_lists', '-o', 'doc.docx'], { cwd: tmp }).catch((e) => {
      throw new DocError('unavailable', /ENOENT/.test(e.message) ? 'Export needs pandoc installed on the server' : 'Export failed: ' + e.message);
    });
    if (format === 'docx') return { name: safe + '.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buf: fs.readFileSync(path.join(tmp, 'doc.docx')) };
    if (format === 'pdf') {
      await run('soffice', [`-env:UserInstallation=file://${tmp}/lo`, '--headless', '--convert-to', 'pdf', '--outdir', tmp, path.join(tmp, 'doc.docx')]).catch(() => {
        throw new DocError('unavailable', 'PDF export needs LibreOffice installed on the server');
      });
      return { name: safe + '.pdf', type: 'application/pdf', buf: fs.readFileSync(path.join(tmp, 'doc.pdf')) };
    }
    throw new DocError('bad_request', 'format must be md, docx or pdf');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
