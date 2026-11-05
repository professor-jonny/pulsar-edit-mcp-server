'use strict';
// Destructive-command guard pattern test (2026-11-14).
// run-command asks a PERSON to approve any command that matches DESTRUCTIVE_RE (lib/command-confirm.js).
// The old pattern  /\b(rm|rmdir|del|rd|format|Remove-Item|ri\s|rd\s.*\/s)\b/i  matched those words ANYWHERE, so
// harmless commands such as `Get-Process | Format-Table` or `node --check lib/format.js` asked for approval.
// This pins three things:
//   1. everything genuinely destructive is still guarded (section 1),
//   2. the harmless look-alikes are NOT guarded (section 2),
//   3. the new pattern never guards a command the old one did not, and the only commands it stops guarding are
//      ones listed in section 2 on purpose (section 3). Adding a command to the corpus that silently becomes
//      unguarded therefore fails here until someone decides it belongs in MUST_NOT_GUARD.
// Pure unit test, no Pulsar. Run from the package root:   node test/command-guard.test.js
const { DESTRUCTIVE_RE } = require('../lib/command-confirm');

const OLD_RE = /\b(rm|rmdir|del|rd|format|Remove-Item|ri\s|rd\s.*\/s)\b/i;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}

// ---- 1. must be guarded ------------------------------------------------------------------------
const MUST_GUARD = [
  // rm
  'rm x', 'rm -rf build', 'RM -RF build', 'rm.exe x', '& rm x', 'echo hi; rm x', 'echo hi && rm x',
  'echo hi | rm x', 'git rm --cached x', 'xargs rm', 'find . -exec rm {} ;',
  'C:\\Program Files\\Git\\usr\\bin\\rm.exe -rf x', '/usr/bin/rm x', './rm x',
  // rmdir / rd (including cmd switch forms with no space)
  'rmdir /s /q x', 'rd /s /q x', 'rd/s/q x', 'RD x',
  // del
  'del x.txt', 'del/f/q x', 'cmd /c del x', 'DEL x', 'Del x.txt',
  // Remove-Item and its alias ri
  'Remove-Item x.txt', 'remove-item -Recurse -Force x', 'Remove-Item x; Get-Date',
  'powershell -Command "Remove-Item x"', 'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
  'ri x', 'ri -Recurse x',
  // the disk format command and Format-Volume
  'format C:', 'format c: /q', 'FORMAT D:', 'format /fs:ntfs D:', 'format.com D:', 'format.exe E: /q',
  'Get-Disk | format D:', 'Format-Volume -DriveLetter D', 'format-volume -DriveLetter D',
];
for (const cmd of MUST_GUARD) {
  check('1 guarded: ' + cmd, DESTRUCTIVE_RE.test(cmd));
}

// ---- 1b. coverage ADDED 2026-11-15: the old pattern let all of these through ---------------------
// Each must be guarded now, and each must NOT have been guarded by the old pattern (checked in 3a2).
const ADDED_COVERAGE = [
  'erase x.txt', 'ERASE x', 'cmd /c erase x',
  'git clean -fd', 'git clean -fdx', 'git clean -n',
  'git reset --hard', 'git reset --hard HEAD~3', 'git reset HEAD~1 --hard',
  'Clear-Disk -Number 1 -RemoveData', 'Remove-Partition -DriveLetter D', 'diskpart', 'diskpart /s script.txt', 'diskpart.exe',
  'Clear-Content x.log',
  'reg delete HKCU\\Software\\X /f', 'reg.exe delete HKLM\\X',
  'robocopy a b /mir', 'robocopy a b /E /PURGE', 'robocopy.exe a b /MIR',
  '[IO.File]::Delete("x")', '[System.IO.Directory]::Delete("x", $true)',
];
for (const cmd of ADDED_COVERAGE) {
  check('1b guarded (added 2026-11-15): ' + cmd, DESTRUCTIVE_RE.test(cmd));
}

// ---- 2. must NOT be guarded (harmless look-alikes) ---------------------------------------------
const MUST_NOT_GUARD = [
  // Format-* cmdlets and format as an option or file name
  'Get-Process | Format-Table -AutoSize', 'Get-Process | Format-List *', 'Get-ChildItem | Format-Wide',
  'Get-Process | Where-Object { $_.ProcessName -match "pulsar" } | Select-Object ProcessName,Id,MainWindowTitle | Format-Table -AutoSize | Out-String -Width 160',
  'git log --format=%H', 'git log --pretty=format:%h', 'git log --pretty=format:"%h %s"',
  'git commit -m "format code"',
  'node --check lib\\format.js', 'node --check lib/format.js', 'Get-ChildItem src/format/x.js',
  'Select-String -Path x.js -Pattern "Format-Table"', 'Where-Object { $_.Name -match "format" }',
  // del / rm / rd glued to a longer name by a dot, hyphen or letter
  'type del.txt', 'Get-Content rm-notes.md', 'Get-Content notes.rm', 'echo transform', 'echo "the 3rd item"',
  'Write-Output "information"',
  // ordinary commands
  'Get-ChildItem -Directory', 'npm run check', 'node test\\check.js --no-tests', 'Get-Content lib\\command-confirm.js',
  'Get-ChildItem $env:TEMP -Filter cps*.js', 'Set-Location (Join-Path $env:USERPROFILE ".pulsar")', 'dir /w',
  // look-alikes of the 2026-11-15 additions that must stay unguarded
  'git status', 'git reset HEAD file.txt', 'git reset --soft HEAD~1', 'git config clean.requireForce true',
  'reg query HKCU\\Software\\X', 'robocopy a b /E', 'robocopy a b /E /Z', 'Clear-Host', 'Get-Content x.log',
  'Get-Disk', 'Get-Partition', 'Get-Volume', 'Get-Content diskpart-notes.txt', 'echo "eraser"', 'echo "erased"',
];
for (const cmd of MUST_NOT_GUARD) {
  check('2 not guarded: ' + cmd, !DESTRUCTIVE_RE.test(cmd));
}

// ---- 3. the new pattern can only get stricter than the old one ---------------------------------
const EXTRA = [
  'git status', 'git diff --stat', 'node -e "console.log(1)"', 'Get-Content package.json', 'dir', 'ls -la', 'cat README.md',
  'Select-String -Path lib\\*.js -Pattern "fragment"', 'npm test', 'node --check lib\\mcp-registration.js',
];
const CORPUS = MUST_GUARD.concat(ADDED_COVERAGE, MUST_NOT_GUARD, EXTRA);
// The old pattern had a stray \b after `ri\s`, so `ri` only matched when the next character was a letter or
// digit: `ri x` was guarded but `ri -Recurse x` slipped through. The new pattern guards both. This list is
// the only place the new pattern is allowed to guard more than the old one did.
const WIDENED_ON_PURPOSE = ['ri -Recurse x'].concat(ADDED_COVERAGE);
const widened = CORPUS.filter(c => DESTRUCTIVE_RE.test(c) && !OLD_RE.test(c));
const unexpectedWidened = widened.filter(c => WIDENED_ON_PURPOSE.indexOf(c) < 0);
check('3a the new pattern guards nothing more than the old one, except the listed gaps it closes', unexpectedWidened.length === 0, unexpectedWidened.join(' | '));
check('3a2 every listed gap really was unguarded before and is guarded now',
  WIDENED_ON_PURPOSE.every(c => !OLD_RE.test(c) && DESTRUCTIVE_RE.test(c)));
const relaxed = CORPUS.filter(c => OLD_RE.test(c) && !DESTRUCTIVE_RE.test(c));
const unintended = relaxed.filter(c => MUST_NOT_GUARD.indexOf(c) < 0);
check('3b every command the new pattern stops guarding is listed in MUST_NOT_GUARD on purpose', unintended.length === 0, unintended.join(' | '));
console.log('INFO  stopped guarding (intended): ' + relaxed.length + ' of ' + CORPUS.length + ' corpus commands');

// ---- 4. shape ----------------------------------------------------------------------------------
check('4a DESTRUCTIVE_RE is a RegExp', DESTRUCTIVE_RE instanceof RegExp);
check('4b it is stateless (no g or y flag), so .test() gives the same answer every time',
  !DESTRUCTIVE_RE.global && !DESTRUCTIVE_RE.sticky && DESTRUCTIVE_RE.test('rm x') && DESTRUCTIVE_RE.test('rm x'));
check('4c it is case-insensitive', DESTRUCTIVE_RE.ignoreCase === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
