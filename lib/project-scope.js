'use strict';
// lib/project-scope.js - which open project roots a project-wide tool covers (XW23 / project scoping, 2026-11-18).
// Pure: no Pulsar, no file access.
//   resolveProjectRoots(roots, project, activePath)
//     project undefined -> the root that holds activePath (deepest match), else the first root
//     project 'all'     -> every root
//     project '<name>'  -> the root whose folder name (or full path) matches, case-insensitive; an unknown or ambiguous
//                          name is an ERROR that lists the names (never a silent fallback to a different project)
//   Returns { ok, roots, mode: 'active'|'first'|'all'|'named', label } or { ok:false, error }.

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();

function resolveProjectRoots(roots, project, activePath) {
  const all = Array.isArray(roots) ? roots.filter(Boolean) : [];
  if (all.length === 0) return { ok: false, error: 'No project root open.' };
  const names = all.map(baseName).join(', ');
  const hint = ` Use project:'all' for every open project, or one of: ${names}.`;

  if (project != null && String(project).trim() !== '') {
    const want = String(project).trim();
    if (want.toLowerCase() === 'all') {
      return { ok: true, roots: all.slice(), mode: 'all', label: `all ${all.length} open project(s)` };
    }
    const hits = all.filter((r) => norm(r) === norm(want) || baseName(r).toLowerCase() === want.toLowerCase());
    if (hits.length === 0) return { ok: false, error: `No open project named "${want}".${hint}` };
    if (hits.length > 1) return { ok: false, error: `Project name "${want}" is ambiguous (${hits.join(' and ')}). Pass the full root path.${hint}` };
    return { ok: true, roots: hits, mode: 'named', label: `project ${baseName(hits[0])}` };
  }

  const ap = norm(activePath);
  let best = null;
  if (ap) {
    for (const r of all) {
      const rn = norm(r);
      if ((ap === rn || ap.startsWith(rn + '/')) && (!best || rn.length > norm(best).length)) best = r;
    }
  }
  const only = all.length === 1;
  const tail = only ? '' : `; ${all.length} open, project:'all' covers them all`;
  if (best) return { ok: true, roots: [best], mode: 'active', label: `project ${baseName(best)}${tail}` };
  return { ok: true, roots: [all[0]], mode: 'first', label: `project ${baseName(all[0])}${tail}` };
}

module.exports = { resolveProjectRoots };
