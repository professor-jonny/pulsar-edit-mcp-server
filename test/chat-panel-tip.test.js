'use strict';
// First-open hint in the chat panel (2026-11-04): the @// shortcut dropdown is not obvious, so the panel
// shows one line saying how to use it when it is built. ChatPanel's constructor needs Pulsar's atom object,
// so these are source checks on lib/chat-panel.js (no Pulsar needed).   Run: node test/chat-panel-tip.test.js
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'chat-panel.js'), 'utf8');
const iCtor = src.indexOf('constructor(serializedState)');
const iEnd = src.indexOf('  showError(message)');
const ctor = iCtor > -1 && iEnd > iCtor ? src.slice(iCtor, iEnd) : '';

check('1a the constructor text was found', ctor.length > 1000, String(ctor.length));
check('1b the constructor builds a tip element', ctor.includes('chat-shortcut-tip'));
const tipText = (ctor.match(/tip\.textContent = '([^']*)'/) || [])[1] || '';
check('1c the tip names the @// trigger and shortcuts.md', tipText.includes('@//') && tipText.includes('shortcuts.md'), tipText);
check('1d the tip text is plain ASCII', tipText.length > 0 && /^[\x20-\x7e]*$/.test(tipText), tipText);
const iAttach = ctor.indexOf('this.element.appendChild(chatDisplay)');
const iTipAdd = ctor.indexOf('chatDisplay.appendChild(tip)');
check('1e the tip is added to the chat display after the display is attached', iAttach > -1 && iTipAdd > iAttach, iAttach + ' / ' + iTipAdd);
check('1f the tip is set with textContent, never innerHTML', !/tip\.innerHTML/.test(ctor));
check('1g the trigger the tip names is the real one (triggerRe in the same file)', src.includes("const triggerRe = /@\\/\\/\\S*$/;"));
check('1h the tip uses the existing info line style', /classList\.add\('chat-command-output', 'chat-command-info'/.test(ctor));

// 2. the tip is readable: it is NOT the small monospace command-output size (PJ: "the text is a bit small")
const less = fs.readFileSync(path.join(__dirname, '..', 'styles', 'pulsar-edit-mcp-server.less'), 'utf8');
const ruleMatch = less.match(/\.chat-shortcut-tip\s*\{([^}]*)\}/);
const rule = ruleMatch ? ruleMatch[1] : '';
check('2a the stylesheet has a .chat-shortcut-tip rule', !!ruleMatch);
check('2b it comes after .chat-command-output so it wins on equal specificity',
  ruleMatch && less.indexOf('.chat-shortcut-tip') > less.indexOf('.chat-command-output'));
check('2c it sizes the text like the message box (@input-font-size)', /font-size:\s*@input-font-size/.test(rule), rule);
check('2d it does not use the monospace command-output font', /font-family:\s*inherit/.test(rule) && !/monospace/.test(rule), rule);
check('2e it never shrinks the text below normal (no em value under 1)', !/font-size:\s*0\.\d+em/.test(rule), rule);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
