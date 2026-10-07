import { describe, expect, it, vi } from 'vitest';

// The mobile vitest project only collects `src/**` and `app/**`, so the module's
// JS side is covered from here, the same way storefront-module.test.ts covers
// the storefront module.

// Stands in for whatever the running binary linked: null on every store build
// before the module shipped, in Expo Go and on the web.
const linkedNativeModule = vi.hoisted(() => ({ current: null as object | null }));
const requireNativeViewManager = vi.hoisted(() => vi.fn(() => function NativeKeyScope() {}));

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => linkedNativeModule.current,
  requireNativeViewManager,
}));

// The view is resolved once at module scope, so each case needs a fresh
// module registry to pick up a different linked module.
async function importModule(native: object | null) {
  linkedNativeModule.current = native;
  requireNativeViewManager.mockClear();
  vi.resetModules();
  return import('../../../modules/spray-editor-input/src/index');
}

describe('spray-editor-input module guard', () => {
  it('has no view, and never asks for one, on a binary without the module', async () => {
    const { NativeSprayEditorKeyScope } = await importModule(null);

    expect(NativeSprayEditorKeyScope).toBeNull();
    // Asking would hand back a component that fails when it renders.
    expect(requireNativeViewManager).not.toHaveBeenCalled();
  });

  it('resolves the view by the name both native modules register', async () => {
    const { NativeSprayEditorKeyScope } = await importModule({});

    expect(NativeSprayEditorKeyScope).not.toBeNull();
    expect(requireNativeViewManager).toHaveBeenCalledWith('SprayEditorInput');
  });
});
