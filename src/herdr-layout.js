// Builds the "main-context" layout from Herdr's own "main" layout:
//   - the right-side panel stack ("panel-body", where Files and Changes live)
//     gets a third child, "context", showing this mod;
//   - the status bar ("status") becomes a row: Herdr's status bar, then this
//     mod's one-line chip, which opens and closes that panel.
// Herdr's shipped layouts are read-only, so this is a separate layout the
// person switches to (ctrl-shift-l); theirs stay untouched.

export const LAYOUT_NAME = 'main-context';
export const MOD = 'herdr-context';

function find(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

/** @returns {object} a new layout; throws if `main` lacks the expected nodes. */
export function withContext(main) {
  const layout = JSON.parse(JSON.stringify(main));
  const body = find(layout, 'panel-body');
  if (body?.type !== 'stack' || !Array.isArray(body.children)) {
    throw new Error("Herdr's main layout has no 'panel-body' panel stack (a newer Herdr?)");
  }
  const status = find(layout, 'status');
  if (status?.type !== 'block') {
    throw new Error("Herdr's main layout has no 'status' bar block (a newer Herdr?)");
  }

  if (!body.children.some((c) => c.id === 'context')) {
    body.children.push({ id: 'context', type: 'block', content: { mod: MOD } });
  }

  const herdrsBar = { ...status, id: 'status-main' };
  delete herdrsBar.size; // fills what the chip leaves
  for (const k of Object.keys(status)) if (!['id', 'size', 'min', 'max', 'hidden'].includes(k)) delete status[k];
  Object.assign(status, {
    type: 'row',
    resizable: false,
    children: [
      herdrsBar,
      { id: 'status-context', type: 'block', size: { px: 300 }, content: { mod: MOD, props: { view: 'chip' } } },
    ],
  });
  return layout;
}
