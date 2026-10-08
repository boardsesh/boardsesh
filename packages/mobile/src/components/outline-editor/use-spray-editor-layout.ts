// Which shape the spray screens take: the phone layout, or the iPad one with
// the photo given the whole screen.
//
// Live, not launch-fixed. An iPad window that narrows (Split View, Slide Over,
// the iPadOS 26 resizable windows) drops below the regular width and gets the
// phone layout, and widens back out the same way. Android tablets keep the
// phone layout: the spray flows only cover the screen on iPad
// (`isIpadSprayFlow`), and the tablet layout is built for that cover.

import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { resolveDeviceLayout, type WidthClass } from '../../theme/size-class';

export type SprayEditorLayoutKind = 'tablet' | 'phone';

export type SprayEditorLayout = {
  layout: SprayEditorLayoutKind;
  /** The window is wider than it is tall. */
  landscape: boolean;
};

/** Tablet only for an iPad window at the regular width (700 pt and up); phone otherwise. */
export function resolveSprayEditorLayout({
  isPad,
  widthClass,
  windowWidth,
  windowHeight,
}: {
  isPad: boolean;
  widthClass: WidthClass;
  windowWidth: number;
  windowHeight: number;
}): SprayEditorLayout {
  return {
    layout: isPad && widthClass === 'regular' ? 'tablet' : 'phone',
    landscape: windowWidth > windowHeight,
  };
}

/**
 * Whether the photo keeps room free under it for the bottom bar. The scan step
 * and the hold editor both fit their photo with this, so the rings land on the
 * pixels the scan band swept on either layout.
 */
export function sprayPhotoReservesBottom(layout: SprayEditorLayoutKind): boolean {
  return layout === 'phone';
}

export function useSprayEditorLayout(viewport?: { width: number; height: number }): SprayEditorLayout {
  const { isPad, isTablet } = useDeviceLayout();
  const window = useWindowDimensions();
  const width = viewport && viewport.width > 0 ? viewport.width : window.width;
  const height = viewport && viewport.height > 0 ? viewport.height : window.height;
  const { widthClass } = resolveDeviceLayout({ width, isTablet });
  return useMemo(
    () => resolveSprayEditorLayout({ isPad, widthClass, windowWidth: width, windowHeight: height }),
    [isPad, widthClass, width, height],
  );
}
