// Optional pre-warmed board database, resolved through a single seam so the
// asset is genuinely optional at the *bundler* level — not just at runtime.
//
// Why the indirection matters: Metro collects every literal `require('…')` it
// can see into the bundle graph at export time (see board-backgrounds-manifest.ts:
// "Metro auto-bundles every require()'d asset"). A literal
// `require('../../assets/boardsesh-seed.db')` of a file that does not exist would
// therefore make `expo export` (and the CI bundle check) FAIL — it is resolved
// during dependency collection, before any try/catch or dead-code elimination can
// help. There is no seed asset committed to this repo, so the default build must
// contain no such literal.
//
// This module is that seam. The committed default returns `null`: zero seed
// reference, so the default bundle stays clean and small and the app runs
// online-only (climb search hits GraphQL). An opt-in build profile that actually
// ships `assets/boardsesh-seed.db` replaces the body of `resolveSeedAssetModuleId`
// with `return require('../../assets/boardsesh-seed.db');` (or points a Metro
// `resolver.resolveRequest` alias at a variant of this file). Either way the
// literal `require` exists only when the asset does. See the OTA section of the
// repo CLAUDE.md.

/**
 * Returns the Metro asset module id for the bundled seed database, or `null`
 * when no seed asset is bundled (the default).
 *
 * The default implementation references no asset, so default builds never put a
 * `require('…seed.db')` literal into the Metro graph. When the opt-in build
 * provides the asset, this is the single function to swap.
 */
export function resolveSeedAssetModuleId(): number | null {
  // Default build: no bundled seed asset. The opt-in profile replaces this body.
  return null;
}
