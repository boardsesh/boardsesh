// Surface context for Button. A region that draws buttons OVER board art / a
// scrim wraps them in <ButtonSurfaceProvider surface="content"> so the
// middle/low-emphasis tiers drop their translucent Liquid Glass for a solid,
// legible capsule. The default is 'surface' (an opaque sheet/card), so every
// existing call site is unchanged. The filled CTA is solid on every surface and
// never reads this — this only protects outlined/tonal/text over busy art.
//
// Pure React (no @expo/ui imports), so both platform Button files can read it.

import { createContext, useContext, type ReactNode } from 'react';
import type { ButtonSurface } from './Button.types';

const ButtonSurfaceContext = createContext<ButtonSurface>('surface');

export function ButtonSurfaceProvider({ surface, children }: { surface: ButtonSurface; children: ReactNode }) {
  return <ButtonSurfaceContext.Provider value={surface}>{children}</ButtonSurfaceContext.Provider>;
}

export function useButtonSurface(): ButtonSurface {
  return useContext(ButtonSurfaceContext);
}
