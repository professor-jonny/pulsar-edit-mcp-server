'use strict';

// Per-project session notes (2026-11-05).
//
// One notes file per project folder, named after the folder: <notes dir>/<folder name>.ndjson (NDJSON, one
// JSON record per line: { ts, project, title, section, items [, edited] }). Pure file logic with no Pulsar
// dependency, so it is unit-tested against a temp folder (test/session-notes-store.test.js).
//
// Which project a call means:
//   read   no project -> the CURRENT project (the open root that holds the active file, else the first root);
//          project:'all' -> every project; project:'name' -> that project
//   write  no project -> the current project; a new name must match an open root or an existing file
//   edit / delete / clear   an explicit project is REQUIRED (indexes are per project); 'all' is refused

const fs = require('fs');
const path = require('path');

const EXT = '.ndjson';
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// A project name becomes a file name, so it must be a safe single path segment.
function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n.length > 80) return null;
  if (n === '.' || n === '..') return null;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return null;
  if (/[. ]$/.test(n)) return null;
  if (RESERVED.test(n)) return null;
  return n;
}

function fileFor(dir, project) {
  const n = sanitizeName(project);
  if (!n) throw new Error('invalid project name: ' + String(project));
  return path.join(dir, n + EXT);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
}

// Open project roots that have a usable folder name (first one wins on a name clash).
function openProjects(roots) {
  const out = [];
  const seen = new Set();
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !root) continue;
    const name = sanitizeName(path.basename(root));
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, root });
  }
  return out;
}

// The current project: the open root holding the active file (deepest wins), else the first root.
function defaultProject(roots, activeFile) {
  const projs = openProjects(roots);
  if (!projs.length) return null;
  if (typeof activeFile === 'string' && activeFile) {
    let best = null;
    for (const p of projs) {
      if (isInside(activeFile, p.root) && (!best || p.root.length > best.root.length)) best = p;
    }
    if (best) return best.name;
  }
  return projs[0].name;
}

async function existingProjects(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith(EXT)) continue;
    const n = f.slice(0, -EXT.length);
    if (sanitizeName(n) === n) out.push(n);
  }
  return out;
}

function uniqueCI(names) {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

async function resolveProject(args) {
  const { requested, action, dir, roots, activeFile } = args || {};
  const open = openProjects(roots).map(p => p.name);
  const known = uniqueCI((await existingProjects(dir)).concat(open));   // stored casing wins
  const knownList = known.length ? known.join(', ') : '(none yet)';
  const needsExplicit = action === 'edit' || action === 'delete' || action === 'clear';
  const canonical = (n) => known.find(k => k.toLowerCase() === String(n).toLowerCase()) || n;

  if (requested === undefined || requested === null || String(requested).trim() === '') {
    if (needsExplicit) {
      return { error: 'project is required for action:' + action + ' (note indexes are per project). Known projects: ' + knownList + '.' };
    }
    const d = defaultProject(roots, activeFile);
    if (!d) return { error: 'No project folder is open to pick a default from. Pass project. Known projects: ' + knownList + '.' };
    return { project: canonical(d) };
  }
  const want = String(requested).trim();
  if (want.toLowerCase() === 'all') {
    if (action === 'read') return { all: true };
    return { error: 'project:"all" is only valid for action:read. Known projects: ' + knownList + '.' };
  }
  const hit = known.find(k => k.toLowerCase() === want.toLowerCase());
  if (hit) return { project: hit };
  return { error: 'Unknown project "' + want + '". Known projects: ' + knownList + '. A new project name must match the name of an open project folder.' };
}

// load: tolerant reader. Lines that are not JSON objects are counted in `bad`, never fatal.
async function load(dir, project) {
  let raw = '';
  try {
    raw = await fs.promises.readFile(fileFor(dir, project), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { records: [], bad: 0 };
    throw e;
  }
  const records = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) records.push(rec); else bad++;
    } catch (_) { bad++; }
  }
  return { records, bad };
}

// append: one new line at the end (never rewrites the file); adds the missing newline first if needed.
async function append(dir, project, entry) {
  const file = fileFor(dir, project);
  await fs.promises.mkdir(dir, { recursive: true });
  let prefix = '';
  try {
    const buf = await fs.promises.readFile(file);
    if (buf.length && buf[buf.length - 1] !== 10) prefix = '\n';
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.promises.appendFile(file, prefix + JSON.stringify(entry) + '\n', 'utf8');
}

// save: replace the whole file (temp file + rename).
async function save(dir, project, records) {
  const file = fileFor(dir, project);
  await fs.promises.mkdir(dir, { recursive: true });
  const text = records.length ? records.map(r => JSON.stringify(r)).join('\n') + '\n' : '';
  const tmpFile = file + '.tmp';
  await fs.promises.writeFile(tmpFile, text, 'utf8');
  await fs.promises.rename(tmpFile, file);
}

async function listProjects(dir) {
  const out = [];
  for (const name of await existingProjects(dir)) {
    const { records } = await load(dir, name);
    const last = records[records.length - 1];
    out.push({ project: name, count: records.length, lastTs: last ? String(last.ts || last.timestamp || '') : '', lastTitle: last ? String(last.title || '') : '' });
  }
  out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
  return out;
}

// First line = title; a following "## heading" line = section; the rest = items.
function parseNoteStr(str) {
  const lines = String(str || '').trim().split('\n').filter(l => l.trim());
  const title = lines[0] || 'Untitled';
  const rest = lines.slice(1);
  let section = null;
  let items = rest;
  if (rest.length > 0 && /^##/.test(rest[0])) {
    section = rest[0].replace(/^#+\s*/, '');
    items = rest.slice(1);
  }
  return { title, section, items };
}

// Text for one project: header, then records grouped by consecutive equal title, each with its [index].
function formatNotes(project, records, opts) {
  const o = opts || {};
  const bad = o.bad || 0;
  const total = records.length;
  const badNote = bad ? '\nWARNING: ' + bad + ' unreadable line(s) in this project\'s notes file were skipped (edit and delete are refused until they are fixed by hand).' : '';
  if (total === 0) return 'No notes recorded yet for project "' + project + '".' + badNote;
  const entries = o.tail ? records.slice(-o.tail) : records;
  const startIdx = total - entries.length;
  const groups = [];
  let cur = null;
  entries.forEach((rec, i) => {
    const absIdx = startIdx + i;
    const ts = rec.ts || rec.timestamp || '?';
    if (!cur || cur.title !== rec.title) {
      cur = { title: rec.title || '(untitled)', ts, sections: [] };
      groups.push(cur);
    }
    const body = rec.items
      ? rec.items.join('\n')
      : (Array.isArray(rec.note) ? rec.note.join('\n') : (rec.note || ''));
    cur.sections.push({ absIdx, section: rec.section || null, body });
  });
  const blocks = groups.map(g => {
    const secs = g.sections.map(s => {
      const idxTag = '[' + s.absIdx + ']';
      return s.section ? '### ' + s.section + '  ' + idxTag + '\n' + s.body : idxTag + '\n' + s.body;
    });
    return ['## ' + g.title + '  [' + g.ts + ']'].concat(secs).join('\n');
  });
  const header = 'Project: ' + project + ' (' + total + ' note(s)' + (entries.length < total ? ', showing last ' + entries.length : '') + ')';
  const hint = 'Indexes in [brackets] are per project: pass project:"' + project + '" with edit or delete.';
  return header + '\n' + hint + '\n\n' + blocks.join('\n\n---\n\n') + badNote;
}

// project:'all' - every non-empty project under its own header. items: [{ project, records, bad }]
function formatAll(items, opts) {
  const parts = (items || []).filter(p => p.records.length > 0 || p.bad > 0).map(p => formatNotes(p.project, p.records, { tail: (opts || {}).tail, bad: p.bad }));
  if (!parts.length) return 'No notes recorded yet in any project.';
  return parts.join('\n\n==========\n\n');
}

// One-line index of the other projects that have notes (the steer towards reading them on purpose).
function formatOthers(list, current) {
  const cur = String(current || '').toLowerCase();
  const rows = (list || []).filter(p => p.count > 0 && p.project.toLowerCase() !== cur);
  if (!rows.length) return '';
  const items = rows.map(p => {
    const title = p.lastTitle ? ', last: "' + (p.lastTitle.length > 50 ? p.lastTitle.slice(0, 47) + '...' : p.lastTitle) + '"' : '';
    return p.project + ' (' + p.count + ' note' + (p.count === 1 ? '' : 's') + title + ')';
  });
  return '\n\nOther projects with notes: ' + items.join('; ') + '. Read one with project:"name", or project:"all" for everything.';
}

// One-off split of the old single notes file into per-project files. Never mixes into a folder that already
// has per-project files; the old file is kept as <name>.migrated. Records with no usable project label go to
// `unlabeledProject`; labels that differ only in case are merged under the first-seen casing.
async function migrateLegacy(args) {
  const { legacyPath, dir, unlabeledProject, dryRun } = args || {};
  let raw;
  try { raw = await fs.promises.readFile(legacyPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { status: 'no-legacy' }; throw e; }
  if ((await existingProjects(dir)).length) return { status: 'notes-exist' };
  const unl = sanitizeName(unlabeledProject);
  if (!unl) return { status: 'error', error: 'invalid unlabeledProject: ' + String(unlabeledProject) };

  const groups = new Map();
  let total = 0, bad = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch (_) { bad++; continue; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { bad++; continue; }
    const label = typeof rec.project === 'string' ? rec.project : '';
    const name = sanitizeName(label) || unl;
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, records: [] });
    const g = groups.get(key);
    g.records.push(Object.assign({}, rec, { project: g.name }));
    total++;
  }
  const perProject = {};
  for (const g of groups.values()) perProject[g.name] = g.records.length;
  if (dryRun) return { status: 'dry-run', perProject, total, bad };

  const written = [];
  try {
    for (const g of groups.values()) {
      await save(dir, g.name, g.records);
      written.push(fileFor(dir, g.name));
    }
    let target = legacyPath + '.migrated';
    if (fs.existsSync(target)) target = legacyPath + '.migrated-' + Date.now();
    await fs.promises.rename(legacyPath, target);
  } catch (e) {
    for (const f of written) { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } }
    throw e;
  }
  return { status: 'migrated', perProject, total, bad };
}

module.exports = {
  sanitizeName, fileFor, defaultProject, openProjects, existingProjects, resolveProject,
  load, append, save, listProjects, parseNoteStr, formatNotes, formatAll, formatOthers, migrateLegacy,
};
