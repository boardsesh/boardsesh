// modules/accessibility-ui/src/index.ts calls into expo-modules-core at import
// time, which has no native globals under Vitest's node env (`EventEmitter` is
// undefined). This stub is the module as Android, Expo Go and every binary built
// before it see it: absent. Suites that drive it register their own vi.mock of
// the same specifier; accessibility-ui-module.test.ts imports the real file by
// its directory path (`…/src`, which the alias does not match) to test the guard itself.
import type { ComponentType } from 'react';
import type { AccessibilityUINativeModule, LargeContentViewerNativeProps } from '../modules/accessibility-ui/src';

export type {
  AccessibilityUINativeModule,
  DifferentiateWithoutColorChange,
  LargeContentViewerNativeProps,
} from '../modules/accessibility-ui/src';

export const accessibilityUINative: AccessibilityUINativeModule | null = null;
export const NativeLargeContentViewer: ComponentType<LargeContentViewerNativeProps> | null = null;
