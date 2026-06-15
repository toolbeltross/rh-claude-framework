/**
 * Shared session-label derivation for both UIs (v1 `src/`, v2 `src-v2/`).
 *
 * Per the v2 IA spec (docs/research/v2-ia.md), a session picker/tab reads
 * "project (id-slice)". This module is the single source of truth so v1 and v2
 * render identical labels.
 */

/**
 * The project name for a live session: the last path segment of its workspace
 * directory. Prefers the stable `project_dir` (where `claude` was launched / the
 * worktree root) over `current_dir`, which shifts when a session `cd`s into a
 * subdirectory — that volatility was the v1 "wrong tab text" bug.
 *
 * @returns {string|null} project name, or null when no workspace dir is known.
 */
export function sessionProject(s) {
  const dir = s?.workspace?.project_dir || s?.workspace?.current_dir;
  if (!dir) return null;
  return dir.split(/[\\/]/).filter(Boolean).pop() || null;
}

/**
 * Spec-format session label: "project (id-slice)". The id-slice is always
 * present, which disambiguates two sessions in the same workspace (replacing the
 * old collision-only suffix). Falls back to just the slice when no project dir
 * is known (e.g. some headless runs), avoiding a redundant "slice (slice)".
 */
export function sessionLabel(s, id) {
  const slice = id.slice(0, 8);
  const proj = sessionProject(s) || slice;
  return proj === slice ? slice : `${proj} (${slice})`;
}
