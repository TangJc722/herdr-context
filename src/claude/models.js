// Context window sizes of Claude models, as Claude Code's own model table
// gives them (read from the Claude Code 2.1.x binary: `context.window` per
// model id). Models up to Opus 4.6 / Sonnet 4.6 default to 200k and reach 1M
// only with the "[1m]" model suffix, which the session log does not record;
// newer models are natively 1M.
const WINDOWS = {
  'claude-opus-4-0': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-sonnet-4-0': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  'claude-fable-5-2': 1_000_000,
};
// Models whose 200k default can be raised to 1M with the [1m] suffix.
const EXTENDABLE = new Set(['claude-opus-4-6', 'claude-sonnet-4-0', 'claude-sonnet-4-5', 'claude-sonnet-4-6']);

/** "claude-opus-4-5-20251101", "us.anthropic.claude-opus-4-5-...-v1:0", "claude-opus-4-5@2025..." → "claude-opus-4-5". */
export function modelBase(model) {
  // version parts are 1-2 digits; the 8-digit date suffix is left out
  const m = String(model ?? '').toLowerCase().match(/claude-[a-z]+(?:-\d{1,2}(?!\d))*/);
  return m ? m[0] : null;
}

/** Window size for a model id, or null when the model is not known. */
export function modelWindow(model) {
  const base = modelBase(model);
  if (!base) return null;
  if (WINDOWS[base]) return WINDOWS[base];
  // A newer model not in the table yet: from generation 4.7 on, Claude models are natively 1M.
  const v = base.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?$/);
  if (v && (Number(v[1]) >= 5 || (Number(v[1]) === 4 && Number(v[2] ?? 0) >= 7))) return 1_000_000;
  return null;
}

export const canExtendTo1M = (model) => EXTENDABLE.has(modelBase(model));
