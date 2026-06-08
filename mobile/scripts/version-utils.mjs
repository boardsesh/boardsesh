// Shared helpers for the iOS / Android marketing-version computation scripts.
// Kept zero-dependency so callers can run on any Node 18+ runtime.

// Throws rather than calling process.exit() so that `finally` blocks (e.g. the
// Play edit cleanup) still run when a failure happens mid-request. The script
// entrypoints catch this and exit non-zero via failAndExit().
export function die(scriptName, message) {
  throw new Error(`${scriptName}: ${message}`);
}

// Top-level error handler for the entrypoints. Prints to stderr and exits 1,
// after any in-flight `finally` cleanup has already run.
export function failAndExit(scriptName, error) {
  process.stderr.write(`${error?.stack ?? error?.message ?? `${scriptName}: ${String(error)}`}\n`);
  process.exit(1);
}

export function requireEnv(scriptName, name) {
  const value = process.env[name];
  if (!value) die(scriptName, `missing required env var ${name}`);
  return value;
}

export function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function normalize(version) {
  const parts = String(version)
    .trim()
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.join('.');
}

export function compareVersions(left, right) {
  const lp = left.split('.').map(Number);
  const rp = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (lp[index] !== rp[index]) return lp[index] - rp[index];
  }
  return 0;
}

export function bumpPatch(version) {
  const parts = version.split('.').map(Number);
  parts[2] += 1;
  return parts.join('.');
}

// Computes the next marketing version given the value committed in source
// and the most recent publicly-released version (or null if the store has
// no public release yet).
export function pickNextVersion(sourceVersion, releasedVersion) {
  if (!releasedVersion) return sourceVersion;
  const candidate = bumpPatch(releasedVersion);
  return compareVersions(sourceVersion, candidate) > 0 ? sourceVersion : candidate;
}

// Picks the highest version from a list (after normalising). Returns null if
// the list is empty after filtering.
export function highestVersion(versions) {
  const normalised = versions.filter((value) => typeof value === 'string' && value.length > 0).map(normalize);
  if (normalised.length === 0) return null;
  return normalised.sort(compareVersions).at(-1);
}
