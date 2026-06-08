import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Shape of the native module. Both fields are optional because we need
 * to bridge two binary generations:
 *
 *  - New binaries (post-overlay-only rewrite) export `renderHoldsOverlay`,
 *    which writes a transparent PNG containing only the hold markers.
 *  - Old binaries export `renderComposite`, which composites the holds on
 *    top of background images and writes a single combined PNG. Calling
 *    it with an empty `backgroundPaths` array produces the same
 *    transparent holds-only output we want from the new API.
 *
 * This shim lets a JS-only EAS OTA update reach testers without forcing
 * everyone to install a fresh native build first.
 */
type BoardRendererNativeModule = {
  renderHoldsOverlay?(configJson: string, cacheKey: string): Promise<string>;
  renderComposite?(configJson: string, backgroundPaths: string[], cacheKey: string): Promise<string>;
};

// requireOptionalNativeModule returns null (silently) when the module
// isn't linked into the running binary — e.g. in Expo Go, or a dev
// client built before the native module was added. Using the throwing
// `requireNativeModule` here would log a noisy `Cannot find native
// module 'BoardRenderer'` error in the JS console even though the
// hook's fallback path handles it gracefully.
export const boardRendererNative = requireOptionalNativeModule<BoardRendererNativeModule>('BoardRenderer');

// Heuristic: does this error look like "the native binary doesn't actually
// implement this method"? Some Expo NativeModulesProxy configurations
// answer `typeof fn === 'function'` for any property, then throw at
// invocation time. We want to fall through to renderComposite in that
// case, but NOT swallow legitimate render errors (out of memory, invalid
// JSON, disk full, etc.) — those should propagate so the hook's catch
// can log them.
function looksLikeMissingNativeMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message) return false;
  return (
    /is not a function/i.test(message) ||
    /method not found/i.test(message) ||
    /unknown method/i.test(message) ||
    /no such method/i.test(message) ||
    /unimplemented/i.test(message)
  );
}

export async function renderHoldsOverlay(configJson: string, cacheKey: string): Promise<string> {
  if (!boardRendererNative) {
    throw new Error('BoardRenderer native module is not available');
  }
  if (typeof boardRendererNative.renderHoldsOverlay === 'function') {
    // Fast path: typeof said it's a function. On most binaries this just
    // works. On binaries whose NativeModulesProxy lies about method
    // presence, the call throws synchronously or rejects — catch both
    // shapes and fall through to renderComposite only when the error
    // matches the "missing native method" pattern.
    try {
      return await boardRendererNative.renderHoldsOverlay(configJson, cacheKey);
    } catch (error) {
      if (!looksLikeMissingNativeMethod(error)) {
        // Real render failure (OOM, bad JSON, etc.) — propagate so the
        // hook's catch logs it.
        throw error;
      }
      // Fall through to renderComposite below.
    }
  }
  // TODO(remove): backwards-compat shim for the overlay-only refactor.
  //   WHY:   pre-refactor native binaries only export `renderComposite`,
  //          so a JS-only OTA update has to keep working on testers who
  //          haven't installed a fresh preview build yet.
  //   WHEN:  safe to delete once every active EAS preview channel
  //          (`preview-1` through `preview-4`) has been rebuilt onto a
  //          binary that exports `renderHoldsOverlay`.
  //   HOW:   run `bun x -p eas-cli@16 eas channel:view preview-N` for N=1..4 and
  //          confirm each channel's runtime version maps to a build SHA
  //          that postdates the overlay-only commit. Easiest path: run
  //          `vp run mobile:preview-build` for all four channels, then
  //          drop this branch + the `renderComposite` field on
  //          `BoardRendererNativeModule`.
  if (typeof boardRendererNative.renderComposite === 'function') {
    // Old binary path. Empty backgroundPaths means the host-side
    // compositor draws nothing under the overlay, so the resulting PNG
    // is the same transparent holds-only image the new API produces.
    return boardRendererNative.renderComposite(configJson, [], cacheKey);
  }
  throw new Error('BoardRenderer native module exposes no usable render function');
}
