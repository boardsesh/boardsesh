// Vitest stub for `packages/mobile/src/theme/animations`.
//
// The real animations.ts has `export type SpringPreset = keyof typeof springs`
// and `export type TimingPreset = keyof typeof timing` — type exports using
// `keyof typeof X`. In CI's Rolldown worker (Node.js 24), Rolldown's static
// analysis phase traverses into this file even when it is vi.mock()'d, and
// the TypeScript transform does not strip the `keyof typeof` before the parser
// sees it, causing `SyntaxError: Unexpected token 'typeof'`.
//
// This stub exports the same runtime values without TypeScript-specific syntax,
// avoiding the parse error at bundle-build time. Tests that assert on specific
// animation values register their own vi.mock which takes precedence.
//
// Wired via the `/theme\/animations$/` alias in packages/mobile/vite.config.ts.

export const springs = {
  snappy: { damping: 20, stiffness: 300, mass: 0.7 },
  interactive: { damping: 20, stiffness: 250, mass: 1.0 },
  gentle: { damping: 15, stiffness: 150, mass: 1.0 },
  bouncy: { damping: 10, stiffness: 200, mass: 0.7 },
};

export const timing = {
  instant: 50,
  fast: 150,
  normal: 250,
  slow: 350,
};

export const motionByVariant = {
  liquidGlass: {
    standard: { duration: 150 },
    emphasized: { duration: 250 },
  },
  material: {
    standard: { duration: 200, easingBezier: [0.2, 0, 0, 1] },
    emphasized: { duration: 350, easingBezier: [0.05, 0.7, 0.1, 1] },
  },
};

export type SpringPreset = 'snappy' | 'interactive' | 'gentle' | 'bouncy';
export type TimingPreset = 'instant' | 'fast' | 'normal' | 'slow';
export type MotionConfig = {
  duration: number;
  easingBezier?: readonly [number, number, number, number];
};
export type Motion = {
  standard: MotionConfig;
  emphasized: MotionConfig;
};
