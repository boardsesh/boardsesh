import { describe, expect, it } from 'vitest';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { MOONBOARD_HOLD_STATES, MOONBOARD_HOLD_STATE_CODES } from '../moonboard-config';

/**
 * MoonBoard's three hold-role colours are declared twice: here in
 * MOONBOARD_HOLD_STATES (used by the MoonBoard-specific config/BLE paths) and in
 * HOLD_STATE_MAP.moonboard codes 42/43/44 (used by every renderer). Two live
 * copies of the same hexes is a standing drift hazard — noticed while working on
 * issue #3885, where an early draft changed one and not the other. Fail loudly
 * if they diverge.
 *
 * `color` is the LED value the Bluetooth encoders send to the wall
 * (packages/shared/ble-protocol reads it and nothing else); `displayColor` is the
 * screen-tuned value every renderer draws. They must not be swapped or merged.
 */
describe('MoonBoard hold-state colour drift', () => {
  const roles = [
    ['start', MOONBOARD_HOLD_STATES.start, MOONBOARD_HOLD_STATE_CODES.start],
    ['hand', MOONBOARD_HOLD_STATES.hand, MOONBOARD_HOLD_STATE_CODES.hand],
    ['finish', MOONBOARD_HOLD_STATES.finish, MOONBOARD_HOLD_STATE_CODES.finish],
  ] as const;

  for (const [role, state, code] of roles) {
    it(`${role} (code ${code}) matches HOLD_STATE_MAP.moonboard`, () => {
      const canonical = HOLD_STATE_MAP.moonboard[code];
      expect(canonical).toBeDefined();
      expect(canonical.name).toBe(state.name);
      expect(canonical.color).toBe(state.color);
      expect(canonical.displayColor).toBe(state.displayColor);
    });
  }
});
