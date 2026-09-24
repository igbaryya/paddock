/**
 * Lays out a commit graph: which column each commit sits in, and which lines pass through its row.
 *
 * The input is history in topological order (children before parents), each commit naming its
 * parents. The walk keeps one list, `lanes`: column i holds the hash the line in that column is
 * heading for. At each commit:
 *
 *   1. It takes the column already heading for it, or the first free one if nothing was (a branch
 *      tip). Any other column also heading for it ends here: two children sharing a parent converge.
 *   2. Its first parent continues in its own column, so a straight history stays one straight line.
 *   3. Each further parent (a merge) joins a column already heading for that parent, or opens one.
 *
 * Columns are reused once free, so the width is the number of lines alive at once, not the number
 * of branches ever seen. That is the same shape `git log --graph` and editors' graphs produce, and it
 * costs O(commits × width).
 *
 * Pure and DOM-free: the drawer draws rows from `before`, `after` and `column`, and this is tested on
 * its own.
 */

/**
 * @param {{hash: string, parents: string[]}[]} commits topological order, newest first
 * @returns {{hash: string, column: number, before: (string|null)[], after: (string|null)[],
 *            edges: number[], width: number}[]}
 *   `before` / `after` are the columns entering the row from above and leaving it below; `edges` are
 *   the columns below that this commit's own lines start (its parents).
 */
export function layoutGraph(commits) {
  /** @type {(string|null)[]} */
  let lanes = [];
  const rows = [];

  for (const commit of commits) {
    const before = [...lanes];
    let column = lanes.indexOf(commit.hash);
    if (column === -1) {
      column = freeColumn(lanes);
      lanes[column] = commit.hash;
    }
    // Every other line that was heading here stops at this row.
    lanes = lanes.map((hash, index) => (hash === commit.hash && index !== column ? null : hash));

    const [first, ...merged] = commit.parents;
    lanes[column] = first ?? null;
    const edges = first ? [column] : [];
    for (const parent of merged) {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = freeColumn(lanes);
        lanes[target] = parent;
      }
      edges.push(target);
    }

    lanes = trimTrailing(lanes);
    rows.push({ hash: commit.hash, column, before, after: [...lanes], edges, width: 0 });
  }

  const width = Math.max(1, ...rows.map((row) => Math.max(row.before.length, row.after.length, row.column + 1)));
  for (const row of rows) row.width = width;
  return rows;
}

/** @param {(string|null)[]} lanes */
function freeColumn(lanes) {
  const index = lanes.indexOf(null);
  return index === -1 ? lanes.length : index;
}

/** Empty columns at the right edge are not columns: dropping them keeps the graph as narrow as it is. */
function trimTrailing(lanes) {
  let end = lanes.length;
  while (end > 0 && lanes[end - 1] == null) end--;
  return lanes.slice(0, end);
}
