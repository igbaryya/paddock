/**
 * ui/src/git-graph.js — the lane layout for the source control history.
 *
 * The properties that matter: a straight history is one column, a branch opens a column and its
 * merge closes it, two children of one parent converge on it, and freed columns are reused so the
 * graph stays as narrow as the history actually is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph } from '../ui/src/git-graph.js';

const c = (hash, ...parents) => ({ hash, parents });
const columns = (rows) => rows.map((row) => row.column);

test('a straight history is one column', () => {
  const rows = layoutGraph([c('c3', 'c2'), c('c2', 'c1'), c('c1')]);
  assert.deepEqual(columns(rows), [0, 0, 0]);
  assert.equal(rows[0].width, 1);
  assert.deepEqual(rows[2].after, []);
});

test('a merge opens a column for its second parent, and the branch closes back into the first', () => {
  //  m ← merge of a2 (main) and b1 (feature); both come from a1
  const rows = layoutGraph([c('m', 'a2', 'b1'), c('a2', 'a1'), c('b1', 'a1'), c('a1')]);
  assert.deepEqual(columns(rows), [0, 0, 1, 0]);
  assert.deepEqual(rows[0].edges, [0, 1]);
  assert.deepEqual(rows[0].after, ['a2', 'b1']);
  // b1 heads for a1 in its own column, which then converges into column 0 at a1.
  assert.deepEqual(rows[2].after, ['a1', 'a1']);
  assert.deepEqual(rows[3].before, ['a1', 'a1']);
  assert.deepEqual(rows[3].after, []);
  assert.equal(rows[0].width, 2);
});

test('two branch tips sharing a parent converge on it', () => {
  const rows = layoutGraph([c('x', 'base'), c('y', 'base'), c('base')]);
  assert.deepEqual(columns(rows), [0, 1, 0]);
  assert.deepEqual(rows[2].before, ['base', 'base']);
});

test('a freed column is reused rather than widening the graph', () => {
  const rows = layoutGraph([
    c('m1', 'a', 'b'), // opens column 1 for b
    c('b', 'a'), //       b heads for a, converges below
    c('a', 'r'), //       column 1 is free again
    c('m2', 'r', 'd'), // a second tip, not reachable from m1 in this list — takes a free column
    c('d', 'r'),
    c('r'),
  ]);
  assert.ok(rows.every((row) => row.width <= 3));
  assert.deepEqual(rows.at(-1).after, []);
});

test('an empty history lays out as nothing', () => {
  assert.deepEqual(layoutGraph([]), []);
});
