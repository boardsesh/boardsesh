import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPlayerRouteAnimation } from '../player-route-animation';

describe('player route animation', () => {
  it.each(['android', 'ios', 'web'])('selects native motion for %s', (platform) => {
    expect(getPlayerRouteAnimation(platform)).toBe(platform === 'android' ? 'none' : 'slide_from_bottom');
  });

  it('uses the platform policy on the actual initial play route', () => {
    const layout = readFileSync(new URL('../../../app/_layout.tsx', import.meta.url), 'utf8');
    const registration = layout.match(/<Stack\.Screen\s+name="play"[\s\S]*?\/>/)?.[0];
    expect(registration).toBeDefined();
    expect(registration).toMatch(/animation:\s*getPlayerRouteAnimation\(\s*Platform\.OS\s*,?\s*\)/);
    expect(layout).toContain("import { getPlayerRouteAnimation } from '../src/lib/player-route-animation'");
  });
});
