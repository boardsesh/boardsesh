import { describe, expect, it, vi } from 'vitest';

// The mobile vitest project only collects `src/**` and `app/**`, so the
// module's JS side is covered from here, like spray-editor-input-module.test.ts.

const linkedNativeModule = vi.hoisted(() => ({ current: null as object | null }));
const requireNativeViewManager = vi.hoisted(() => vi.fn(() => function NativeLargeContentViewer() {}));
const requireOptionalNativeModule = vi.hoisted(() => vi.fn(() => linkedNativeModule.current));

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule,
  requireNativeViewManager,
}));

async function importModule(native: object | null) {
  linkedNativeModule.current = native;
  requireNativeViewManager.mockClear();
  requireOptionalNativeModule.mockClear();
  vi.resetModules();
  // The directory path skips the vite.config alias (anchored on `…/src/index`)
  // that stubs this module for every other suite.
  return import('../../../modules/accessibility-ui/src');
}

describe('accessibility-ui module guard', () => {
  it('has no module and no view, and never asks for one, on a binary without it', async () => {
    const { accessibilityUINative, NativeLargeContentViewer } = await importModule(null);

    expect(accessibilityUINative).toBeNull();
    expect(NativeLargeContentViewer).toBeNull();
    expect(requireNativeViewManager).not.toHaveBeenCalled();
  });

  it('resolves both by the name the Swift module registers', async () => {
    const { NativeLargeContentViewer } = await importModule({});

    expect(requireOptionalNativeModule).toHaveBeenCalledWith('AccessibilityUI');
    expect(NativeLargeContentViewer).not.toBeNull();
    expect(requireNativeViewManager).toHaveBeenCalledWith('AccessibilityUI');
  });
});
