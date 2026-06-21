import { describe, it, expect, vi } from 'vitest';

// motion-config builds Easing.bezier from reanimated; mock it (animations.ts itself
// is pure data and pulls in nothing).
vi.mock('react-native-reanimated', () => ({
  Easing: { bezier: (...args: number[]) => ({ __bezier: args }) },
}));

import { motionByVariant } from '../animations';
import { timingFor } from '../motion-config';

describe('motionByVariant', () => {
  it('gives Material distinct M3 easing curves + standard durations', () => {
    // standard = M3 standard-easing; emphasized approximates M3's two-part
    // accelerate→decelerate spline with its dominant emphasized-decelerate segment,
    // so it reads as a slower settle — not merely a longer duration than standard.
    expect(motionByVariant.material.standard).toEqual({ duration: 200, easingBezier: [0.2, 0, 0, 1] });
    expect(motionByVariant.material.emphasized).toEqual({ duration: 350, easingBezier: [0.05, 0.7, 0.1, 1] });
    expect(motionByVariant.material.standard.easingBezier).not.toEqual(
      motionByVariant.material.emphasized.easingBezier,
    );
  });

  it('keeps the prior glass durations with no easing override (default ease)', () => {
    expect(motionByVariant.liquidGlass.standard).toEqual({ duration: 150 });
    expect(motionByVariant.liquidGlass.emphasized).toEqual({ duration: 250 });
    expect('easingBezier' in motionByVariant.liquidGlass.standard).toBe(false);
  });
});

describe('timingFor', () => {
  it('builds an Easing.bezier curve from a Material config', () => {
    const config = timingFor(motionByVariant.material.standard);
    expect(config.duration).toBe(200);
    expect(config.easing).toEqual({ __bezier: [0.2, 0, 0, 1] });
  });

  it('omits easing for a glass config (so reanimated uses its default ease)', () => {
    const config = timingFor(motionByVariant.liquidGlass.emphasized);
    expect(config.duration).toBe(250);
    expect(config.easing).toBeUndefined();
  });
});
