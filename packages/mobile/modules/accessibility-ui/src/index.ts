import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

export type DifferentiateWithoutColorChange = { enabled: boolean };

export type AccessibilityUINativeModule = {
  /** iOS Settings > Accessibility > Display & Text Size > Differentiate Without Color. */
  isDifferentiateWithoutColorEnabled(): Promise<boolean>;
  addListener(
    event: 'onDifferentiateWithoutColorChange',
    listener: (payload: DifferentiateWithoutColorChange) => void,
  ): EventSubscription;
};

export type LargeContentViewerNativeProps = ViewProps & {
  /** What the Large Content Viewer shows. Empty or absent shows nothing. */
  title?: string;
  /** An SF Symbol name shown above the title. */
  systemImage?: string;
  /** The finger lifted on the view while the viewer was up. */
  onLargeContentViewerActivate?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
};

// iOS only, and new with this binary, so JS published as an OTA can land on a
// binary without it. requireOptionalNativeModule returns null there (and on
// Android, in Expo Go and on the web) without throwing, and the view is only
// asked for when the module is present: requireNativeViewManager on an absent
// module hands back a component that fails when it renders. The
// 'AccessibilityUI' string must match Name("AccessibilityUI") in
// ios/AccessibilityUIModule.swift.
export const accessibilityUINative = requireOptionalNativeModule<AccessibilityUINativeModule>('AccessibilityUI');

/** The native view, or null when the running binary does not have it. */
export const NativeLargeContentViewer: ComponentType<LargeContentViewerNativeProps> | null = accessibilityUINative
  ? requireNativeViewManager<LargeContentViewerNativeProps>('AccessibilityUI')
  : null;
