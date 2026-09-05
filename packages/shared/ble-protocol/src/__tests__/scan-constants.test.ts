// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vitest';

import { SCAN_TIMEOUT_MS, SERIAL_RECONNECT_GRACE_MS } from '../scan-constants';

describe('scan constants', () => {
  it('gives a reconnecting board enough time to re-advertise before the picker (#3609)', () => {
    // Aurora boxes routinely take longer than a few seconds to re-advertise
    // after a link loss. The grace must be generous enough that a present board
    // reconnects silently, or the "silent" reconnect flashes the picker on most
    // mid-session reconnects. A lower bound guards against a regression back to
    // the old 4s value without pinning an exact literal a deliberate future tune
    // would trip.
    expect(SERIAL_RECONNECT_GRACE_MS).toBeGreaterThanOrEqual(8_000);
  });

  it('keeps the grace window well inside the overall scan window', () => {
    // A genuinely-absent board must still reach the picker with live-scan time
    // to spare. If a future edit ever inverts these two, the picker would only
    // appear as the scan ends (or never), so pin the ordering.
    expect(SERIAL_RECONNECT_GRACE_MS).toBeLessThan(SCAN_TIMEOUT_MS);
  });
});
