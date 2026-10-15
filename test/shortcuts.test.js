/**
 * ui/src/shortcuts.js — how a key press becomes a stored shortcut, and how stored ones are trusted.
 *
 * Two things matter most. A press must read the same whatever Shift or ⌥ did to the character, or a
 * shortcut recorded as ⌥⇧P would never match itself again; and whatever is in localStorage — an old
 * release's, a hand-edited one — must come back as a set where no combination runs two actions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BINDINGS,
  actionFor,
  changedFromDefaults,
  comboFromEvent,
  formatCombo,
  isCombo,
  normalizeBindings,
  rejectCombo,
} from '../ui/src/shortcuts.js';

const press = (key, code, mods = {}) => ({ key, code, ...mods });

test('a press is read as Mod, Alt, Shift and then the key, in that order', () => {
  assert.equal(comboFromEvent(press('k', 'KeyK', { metaKey: true })), 'Mod+K');
  assert.equal(comboFromEvent(press('k', 'KeyK', { ctrlKey: true })), 'Mod+K');
  assert.equal(comboFromEvent(press('P', 'KeyP', { metaKey: true, shiftKey: true })), 'Mod+Shift+P');
  assert.equal(comboFromEvent(press('π', 'KeyP', { altKey: true, shiftKey: true, metaKey: true })), 'Mod+Alt+Shift+P');
});

test('Shift and ⌥ changing the character do not change the key', () => {
  assert.equal(comboFromEvent(press('?', 'Slash', { metaKey: true, shiftKey: true })), 'Mod+Shift+/');
  assert.equal(comboFromEvent(press('!', 'Digit1', { altKey: true, shiftKey: true })), 'Alt+Shift+1');
  assert.equal(comboFromEvent(press('<', 'Comma', { metaKey: true, shiftKey: true })), 'Mod+Shift+,');
});

test('the letter on the keycap wins on another layout', () => {
  // AZERTY: the key in QWERTY's Q position types "a".
  assert.equal(comboFromEvent(press('a', 'KeyQ', { metaKey: true })), 'Mod+A');
});

test('a modifier on its own is not a combination yet', () => {
  for (const key of ['Meta', 'Control', 'Shift', 'Alt']) {
    assert.equal(comboFromEvent(press(key, `${key}Left`, { metaKey: true })), null);
  }
});

test('every default is a combination the reader can produce, and none is rejected', () => {
  for (const [id, combo] of Object.entries(DEFAULT_BINDINGS)) {
    if (combo === null) continue;
    assert.ok(isCombo(combo), `${id}: ${combo}`);
    assert.equal(rejectCombo(combo, true), null, `${id}: ${combo}`);
  }
});

test('combinations are drawn the way each platform draws them', () => {
  assert.equal(formatCombo('Mod+Shift+P', true), '⌘⇧P');
  assert.equal(formatCombo('Mod+Alt+Shift+P', true), '⌘⌥⇧P');
  assert.equal(formatCombo('Mod+Shift+P', false), 'Ctrl+Shift+P');
  assert.equal(formatCombo('Mod+Enter', true), '⌘↩');
  assert.equal(formatCombo(null, true), '');
});

test('a bare key, an application number, and the window\'s own keys are refused', () => {
  assert.match(rejectCombo('K', true), /would fire as you type/);
  assert.match(rejectCombo('Shift+K', false), /Ctrl or Alt/);
  assert.match(rejectCombo('Mod+3', true), /switch between applications/);
  assert.equal(rejectCombo('Mod+Q', true), '⌘Q already quits.');
  assert.equal(rejectCombo('Mod+C', false), 'Ctrl+C already copies.');
  assert.equal(rejectCombo('F5', true), null);
  assert.equal(rejectCombo('Mod+Shift+3', true), null);
});

test('stored bindings: unknown actions and unreadable values are dropped, null is kept', () => {
  const bindings = normalizeBindings({
    palette: 'Mod+P',
    newApplication: null,
    gone: 'Mod+G',
    goPorts: 'Shift+Mod+X', // not in canonical order
    goSettings: 42,
  });
  assert.equal(bindings.palette, 'Mod+P');
  assert.equal(bindings.newApplication, null);
  assert.equal('gone' in bindings, false);
  assert.equal(bindings.goPorts, DEFAULT_BINDINGS.goPorts);
  assert.equal(bindings.goSettings, DEFAULT_BINDINGS.goSettings);
});

test('stored bindings: a combination bound twice stays with the earlier action only', () => {
  const bindings = normalizeBindings({ toggleSidebar: 'Mod+K' });
  assert.equal(bindings.palette, 'Mod+K');
  assert.equal(bindings.toggleSidebar, null);
  assert.equal(actionFor(bindings, 'Mod+K'), 'palette');
});

test('anything that is not an object reads as the defaults', () => {
  for (const stored of [null, 'Mod+K', 7, undefined]) {
    assert.deepEqual(normalizeBindings(stored), DEFAULT_BINDINGS);
  }
});

test('only changes from the defaults are stored', () => {
  const bindings = { ...DEFAULT_BINDINGS, palette: 'Mod+P', newApplication: null };
  assert.deepEqual(changedFromDefaults(bindings), { palette: 'Mod+P', newApplication: null });
});

test('the action being rebound does not conflict with itself', () => {
  assert.equal(actionFor(DEFAULT_BINDINGS, 'Mod+K', 'palette'), null);
  assert.equal(actionFor(DEFAULT_BINDINGS, 'Mod+K', 'goPorts'), 'palette');
});
