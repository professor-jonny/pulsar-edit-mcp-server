'use strict';
// Per-project session notes (2026-11-05). One notes file per project folder, named after the folder:
// <session dir>/notes/<folder name>.ndjson. Reading defaults to the current project, other projects can be
// read by name, and the old single file is split into per-project files once.
// Pure tests on lib/session-notes-store.js against a temp folder, plus source checks on the tool wiring.
// No Pulsar, no restart needed.   Run from the package root:   node test/session-notes-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}
function throws(fn) { try { fn(); return false; } catch (_) { return true; } }

const store = require('../lib/session-notes-store');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-test-'));

async function main() {
  // ---- 1. names ----------------------------------------------------------------------------------
  check('1a ordinary folder names are accepted unchanged',
    ['pulsar-edit-mcp-server', 'Ghidra-H8-Processor', 'h8', 'my project', 'a.b_c-1'].every(n => store.sanitizeName(n) === n));
  check('1b surrounding spaces are trimmed', store.sanitizeName('  h8  ') === 'h8');
  check('1c empty names, dots, separators and reserved characters are rejected',
    ['', '   ', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0000b'].every(n => store.sanitizeName(n) === null));
  check('1d Windows device names and a trailing dot are rejected', ['CON', 'nul', 'Com1', 'LPT9', 'name.'].every(n => store.sanitizeName(n) === null));
  check('1e non-strings and over-long names are rejected',
    store.sanitizeName(null) === null && store.sanitizeName(5) === null && store.sanitizeName('x'.repeat(81)) === null && store.sanitizeName('x'.repeat(80)) === 'x'.repeat(80));
  check('1f fileFor gives <dir>/<name>.ndjson and refuses unsafe names',
    store.fileFor('D', 'h8') === path.join('D', 'h8.ndjson') && throws(() => store.fileFor('D', '..')) && throws(() => store.fileFor('D', 'a/b')));

  // ---- 2. which project is "current" -------------------------------------------------------------
  const base = path.join(tmp, 'roots');
  const rA = path.join(base, 'Alpha'), rB = path.join(base, 'Beta'), rD = path.join(base, 'Delta');
  const rNested = path.join(rA, 'sub', 'Gamma'), rFoo = path.join(base, 'foo'), rFooBar = path.join(base, 'foobar');
  check('2a with no active file the first root is the default', store.defaultProject([rA, rB], null) === 'Alpha');
  check('2b the root that holds the active file wins', store.defaultProject([rA, rB], path.join(rB, 'x.js')) === 'Beta');
  check('2c with nested roots the deepest one wins',
    store.defaultProject([rA, rNested], path.join(rNested, 'x.js')) === 'Gamma' && store.defaultProject([rA, rNested], path.join(rA, 'y.js')) === 'Alpha');
  check('2d a sibling with the same prefix is not inside (foo vs foobar)', store.defaultProject([rFoo, rFooBar], path.join(rFooBar, 'x.js')) === 'foobar');
  check('2e an active file outside every root falls back to the first root', store.defaultProject([rA, rB], path.join(base, 'other', 'x.js')) === 'Alpha');
  check('2f no roots means no default', store.defaultProject([], null) === null && store.defaultProject(undefined, 'x') === null);
  check('2g a root whose folder name is unusable is skipped', store.defaultProject([path.parse(tmp).root, rB], null) === 'Beta');
  if (process.platform === 'win32') {
    check('2h paths compare case-insensitively on Windows', store.defaultProject([rA, rB], path.join(rB.toUpperCase(), 'x.js')) === 'Beta');
  }

  // ---- 3. files: append, load, save --------------------------------------------------------------
  const dir = path.join(tmp, 'notes');   // does not exist yet
  let r = await store.load(dir, 'Alpha');
  check('3a loading a missing project gives no records', r.records.length === 0 && r.bad === 0);
  await store.append(dir, 'Alpha', { ts: '2026-01-01T00:00:00.000Z', project: 'Alpha', title: 'one', section: null, items: ['a'] });
  await store.append(dir, 'Alpha', { ts: '2026-01-02T00:00:00.000Z', project: 'Alpha', title: 'two', section: 'S', items: ['b', 'c'] });
  r = await store.load(dir, 'Alpha');
  check('3b append creates the folder and keeps the order', r.records.length === 2 && r.records[0].title === 'one' && r.records[1].items.length === 2);
  check('3c the file is named after the project and ends with a newline', fs.readFileSync(path.join(dir, 'Alpha.ndjson'), 'utf8').endsWith('\n'));
  fs.appendFileSync(path.join(dir, 'Alpha.ndjson'), '{"ts":"2026-01-03T00:00:00.000Z","title":"three","items":[]}');   // no trailing newline
  await store.append(dir, 'Alpha', { ts: '2026-01-04T00:00:00.000Z', title: 'four', items: [] });
  r = await store.load(dir, 'Alpha');
  check('3d append after a line with no trailing newline does not glue two records together', r.records.length === 4 && r.bad === 0, JSON.stringify(r));
  fs.appendFileSync(path.join(dir, 'Alpha.ndjson'), 'this is not json\n');
  r = await store.load(dir, 'Alpha');
  check('3e an unreadable line is counted, not fatal, and the rest still loads', r.records.length === 4 && r.bad === 1, JSON.stringify(r));
  await store.save(dir, 'Alpha', r.records.slice(0, 2));
  r = await store.load(dir, 'Alpha');
  check('3f save replaces the file contents', r.records.length === 2 && r.bad === 0);
  check('3g save leaves no temp file behind', fs.readdirSync(dir).every(f => !f.endsWith('.tmp')));
  await store.save(dir, 'Beta', []);
  r = await store.load(dir, 'Beta');
  check('3h saving an empty list gives an empty but existing project', r.records.length === 0 && fs.existsSync(path.join(dir, 'Beta.ndjson')));

  // ---- 4. listing projects ----------------------------------------------------------------------
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a notes file');
  await store.append(dir, 'Gamma', { ts: '2026-02-01T00:00:00.000Z', title: 'newest note', items: [] });
  const list = await store.listProjects(dir);
  check('4a every project file is listed with its count', list.map(p => p.project + ':' + p.count).sort().join(',') === 'Alpha:2,Beta:0,Gamma:1', JSON.stringify(list));
  check('4b the most recently written project comes first and shows its last title', list[0].project === 'Gamma' && list[0].lastTitle === 'newest note', JSON.stringify(list[0]));
  check('4c files that are not .ndjson are ignored', !list.some(p => /readme/.test(p.project)));
  check('4d a missing folder lists nothing', (await store.listProjects(path.join(tmp, 'nope'))).length === 0);

  // ---- 5. resolving the project for an action ---------------------------------------------------
  const rp = (o) => store.resolveProject(Object.assign({ dir, roots: [rA, rB], activeFile: null }, o));
  let x = await rp({ action: 'read' });
  check('5a read with no project uses the default (the first root)', x.project === 'Alpha', JSON.stringify(x));
  x = await rp({ action: 'read', activeFile: path.join(rB, 'f.js') });
  check('5b ... or the root of the active file', x.project === 'Beta', JSON.stringify(x));
  x = await rp({ action: 'read', requested: 'gamma' });
  check('5c an explicit name matches case-insensitively and returns the stored casing', x.project === 'Gamma', JSON.stringify(x));
  x = await rp({ action: 'read', requested: 'ALL' });
  check('5d project all is accepted for read', x.all === true, JSON.stringify(x));
  x = await rp({ action: 'write', requested: 'all' });
  check('5e ... but not for write', !!x.error && /only valid for action:read/.test(x.error), JSON.stringify(x));
  x = await rp({ action: 'read', requested: 'Nope' });
  check('5f an unknown project is an error that lists the known ones', !!x.error && /Alpha/.test(x.error) && /Gamma/.test(x.error) && /Nope/.test(x.error), JSON.stringify(x));
  x = await rp({ action: 'write', requested: 'Typo' });
  check('5g write to an unknown project that is not open is refused', !!x.error, JSON.stringify(x));
  check('5h ... and no file is created for it', !fs.existsSync(path.join(dir, 'Typo.ndjson')));
  x = await rp({ action: 'write' });
  check('5i write with no project goes to the current project', x.project === 'Alpha', JSON.stringify(x));
  x = await rp({ action: 'write', requested: 'delta', roots: [rA, rB, rD] });
  check('5j write to an open root that has no file yet is allowed (canonical name)', x.project === 'Delta', JSON.stringify(x));
  for (const act of ['edit', 'delete', 'clear']) {
    x = await rp({ action: act });
    check('5k ' + act + ' requires an explicit project', !!x.error && /required/.test(x.error) && /per project/.test(x.error), JSON.stringify(x));
    x = await rp({ action: act, requested: 'all' });
    check('5l ' + act + ' refuses project all', !!x.error, JSON.stringify(x));
    x = await rp({ action: act, requested: 'alpha' });
    check('5m ' + act + ' with an explicit project resolves it', x.project === 'Alpha', JSON.stringify(x));
  }
  x = await store.resolveProject({ action: 'read', dir: path.join(tmp, 'empty-dir'), roots: [], activeFile: null });
  check('5n no open folder and no files gives a clear error', !!x.error && /Pass project/.test(x.error), JSON.stringify(x));

  // ---- 6. parsing and formatting ----------------------------------------------------------------
  const pn = store.parseNoteStr('Title line\n## Section\nitem 1\nitem 2');
  check('6a parseNoteStr: first line is the title, a ## line the section, the rest the items', pn.title === 'Title line' && pn.section === 'Section' && pn.items.join('|') === 'item 1|item 2', JSON.stringify(pn));
  const pn2 = store.parseNoteStr('Just a title');
  check('6b a note with no body has no section and no items', pn2.section === null && pn2.items.length === 0);
  check('6c a blank note becomes Untitled', store.parseNoteStr('   ').title === 'Untitled');
  const recs = [
    { ts: 'T1', title: 'Alpha handover', section: null, items: ['x', 'y'] },
    { ts: 'T2', title: 'Alpha handover', section: 'Next', items: ['z'] },
    { ts: 'T3', title: 'Other', section: null, items: ['w'] },
  ];
  const txt = store.formatNotes('Alpha', recs, {});
  check('6d the header names the project and the total', /^Project: Alpha \(3 note\(s\)\)/.test(txt), txt.slice(0, 80));
  check('6e it says that indexes are per project', /per project/i.test(txt));
  check('6f consecutive records with one title are grouped under one heading', (txt.match(/## Alpha handover/g) || []).length === 1 && txt.includes('### Next  [1]'), txt);
  check('6g every record carries its [index]', txt.includes('[0]') && txt.includes('[1]') && txt.includes('[2]'));
  const tailTxt = store.formatNotes('Alpha', recs, { tail: 1 });
  check('6h tail:1 shows only the last record but keeps its absolute index', tailTxt.includes('[2]') && !tailTxt.includes('[0]') && /showing last 1/.test(tailTxt), tailTxt);
  check('6i an empty project says so', /No notes recorded yet for project "Alpha"/.test(store.formatNotes('Alpha', [], {})));
  check('6j unreadable lines are reported', /1 unreadable line/.test(store.formatNotes('Alpha', recs, { bad: 1 })));
  const others = [{ project: 'Alpha', count: 3, lastTitle: 'a' }, { project: 'Gamma', count: 1, lastTitle: 'newest note' }, { project: 'Beta', count: 0, lastTitle: '' }];
  const fo = store.formatOthers(others, 'alpha');
  check('6k the footer lists other projects that have notes, not the current or empty ones', fo.includes('Gamma (1 note') && !fo.includes('Alpha (') && !fo.includes('Beta'), fo);
  check('6l the footer says how to read another project or all', /project:"name"/.test(fo) && /project:"all"/.test(fo), fo);
  check('6m with no other projects the footer is empty', store.formatOthers([{ project: 'Alpha', count: 3, lastTitle: 'a' }], 'Alpha') === '');
  const fa = store.formatAll([{ project: 'Alpha', records: recs, bad: 0 }, { project: 'Gamma', records: [{ ts: 'T9', title: 'g', section: null, items: ['q'] }], bad: 0 }, { project: 'Beta', records: [], bad: 0 }], {});
  check('6n project all shows each non-empty project under its own header', fa.includes('Project: Alpha') && fa.includes('Project: Gamma') && !fa.includes('Project: Beta'), fa.slice(0, 200));
  check('6o project all with nothing anywhere says so', /No notes recorded yet in any project/.test(store.formatAll([], {})));

  // ---- 7. migrating the old single file ---------------------------------------------------------
  const mroot = path.join(tmp, 'mig');
  const mdir = path.join(mroot, 'notes');
  const legacy = path.join(mroot, 'session-notes.ndjson');
  fs.mkdirSync(mroot, { recursive: true });
  const L = [
    { ts: '2026-10-01T00:00:00.000Z', project: 'Alpha', title: 't1', section: null, items: ['1'] },
    { ts: '2026-10-02T00:00:00.000Z', project: 'alpha', title: 't2', section: 'S', items: ['2'], edited: '2026-10-03T00:00:00.000Z' },
    { ts: '2026-10-04T00:00:00.000Z', project: null, title: 't3', section: null, items: ['3'] },
    { ts: '2026-10-05T00:00:00.000Z', title: 't4', section: null, items: ['4'] },
    { ts: '2026-10-06T00:00:00.000Z', project: 'Beta', title: 't5', section: null, items: ['5'] },
    { ts: '2026-10-07T00:00:00.000Z', project: 'bad/name', title: 't6', section: null, items: ['6'] },
    { ts: '2026-10-08T00:00:00.000Z', project: '   ', title: 't7', section: null, items: ['7'] },
  ];
  fs.writeFileSync(legacy, L.map(rec => JSON.stringify(rec)).join('\n') + '\nnot json at all\n');
  const legacyBefore = fs.readFileSync(legacy, 'utf8');
  let m = await store.migrateLegacy({ legacyPath: legacy, dir: mdir, unlabeledProject: 'Home', dryRun: true });
  check('7a a dry run reports the split and the unreadable line', m.status === 'dry-run' && m.perProject.Alpha === 2 && m.perProject.Beta === 1 && m.perProject.Home === 4 && m.total === 7 && m.bad === 1, JSON.stringify(m));
  check('7b ... and leaves the legacy file and the folder alone', fs.readFileSync(legacy, 'utf8') === legacyBefore && !fs.existsSync(mdir));
  m = await store.migrateLegacy({ legacyPath: legacy, dir: mdir, unlabeledProject: 'Home' });
  check('7c the real run says migrated with the same counts', m.status === 'migrated' && m.total === 7 && m.perProject.Alpha === 2, JSON.stringify(m));
  const a = (await store.load(mdir, 'Alpha')).records;
  check('7d case variants merge under the first-seen casing, in order, keeping every field',
    a.length === 2 && a[0].title === 't1' && a[1].title === 't2' && a[1].edited === '2026-10-03T00:00:00.000Z' && a[1].section === 'S' && a.every(rec => rec.project === 'Alpha'), JSON.stringify(a));
  const h = (await store.load(mdir, 'Home')).records;
  check('7e unlabeled, blank and unusable labels go to the unlabeled project', h.map(rec => rec.title).join(',') === 't3,t4,t6,t7' && h.every(rec => rec.project === 'Home'), JSON.stringify(h));
  check('7f nothing is lost: the written records add up to the legacy records', (await store.listProjects(mdir)).reduce((n, p) => n + p.count, 0) === L.length);
  check('7g the old file is kept as .migrated, byte for byte', !fs.existsSync(legacy) && fs.readFileSync(legacy + '.migrated', 'utf8') === legacyBefore);
  m = await store.migrateLegacy({ legacyPath: legacy, dir: mdir, unlabeledProject: 'Home' });
  check('7h running it again is a no-op', m.status === 'no-legacy', JSON.stringify(m));
  fs.writeFileSync(legacy, JSON.stringify({ ts: 'x', title: 'late', items: [] }) + '\n');
  m = await store.migrateLegacy({ legacyPath: legacy, dir: mdir, unlabeledProject: 'Home' });
  check('7i a legacy file that appears beside existing per-project files is left alone', m.status === 'notes-exist' && fs.existsSync(legacy), JSON.stringify(m));
  m = await store.migrateLegacy({ legacyPath: legacy, dir: path.join(tmp, 'mig2', 'notes'), unlabeledProject: '../evil' });
  check('7j a bad unlabeled project name is an error and nothing is written', m.status === 'error' && !fs.existsSync(path.join(tmp, 'mig2')), JSON.stringify(m));

  // ---- 8. wiring in the tool ---------------------------------------------------------------------
  const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
  const sStart = reg.indexOf('-- session-notes ---');
  const sEnd = reg.indexOf('} // end debugging group');
  const sn = sStart > -1 && sEnd > sStart ? reg.slice(sStart, sEnd) : '';
  check('8a the session-notes block was found', sn.length > 1500, String(sn.length));
  check('8b mcp-registration requires the store', /require\('\.\/session-notes-store'\)/.test(reg));
  check('8c the tool no longer reads one shared notes file', !/function loadNotes/.test(sn) && !/const notesPath/.test(sn));
  check('8d notes live in a notes folder inside the session dir', /'notes'\)/.test(sn));
  check('8e the old single file is only the migration source', /migrateLegacy\(/.test(sn) && /legacyNotesPath/.test(sn));
  check('8f the project is resolved through the store before any action', /notesStore\.resolveProject\(/.test(sn));
  check('8g the old removed.timestamp bug is gone', !/removed\.timestamp/.test(sn));
  check('8h the tool description says how to read other projects and which actions need a project', /project:'all'/.test(sn) && /REQUIRE an explicit project/.test(sn));
  check('8i write appends to the project file', /notesStore\.append\(/.test(sn));
  check('8j edit and delete refuse a file that has unreadable lines', (sn.match(/unreadable line/g) || []).length >= 2, String((sn.match(/unreadable line/g) || []).length));
  const cat = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tool-catalogue.js'), 'utf8');
  const catLine = cat.split('\n').find(l => l.includes('name: "session-notes"')) || '';
  check('8k the tool catalogue describes one notes file per project', /one file per project/i.test(catLine), catLine.slice(0, 200));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} console.log('FAIL test crashed: ' + (e && e.stack || e)); process.exit(1); });
