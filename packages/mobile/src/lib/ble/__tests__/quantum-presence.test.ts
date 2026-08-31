import { describe, expect, it } from 'vitest';
import { sanitizeQuantumRosterForPresence } from '../quantum-presence';

describe('sanitizeQuantumRosterForPresence', () => {
  it('reports resolved metadata without controller ids and retains foreign occupancy', () => {
    const targetRoute = '10000000-0000-4000-8000-000000000001';
    const foreignRoute = '10000000-0000-4000-8000-000000000002';
    const layers = sanitizeQuantumRosterForPresence(
      {
        revision: 4,
        observedAtMs: 1_000,
        players: [
          {
            routeId: targetRoute,
            userId: '20000000-0000-4000-8000-000000000001',
            remainingSeconds: 60,
            color: 0x00ff00,
          },
          {
            routeId: foreignRoute,
            userId: '20000000-0000-4000-8000-000000000002',
            remainingSeconds: 42,
            color: 0xff00ff,
          },
        ],
      },
      new Map([[targetRoute, { climbUuid: 'boardsesh-climb', angle: 40, geometryKnown: true }]]),
    );

    expect(layers).toEqual([
      {
        color: '#00ff00',
        remainingSeconds: 60,
        climbUuid: 'boardsesh-climb',
        angle: 40,
        geometryKnown: true,
      },
      {
        color: '#ff00ff',
        remainingSeconds: 42,
        climbUuid: null,
        angle: null,
        geometryKnown: false,
      },
    ]);
    expect(JSON.stringify(layers)).not.toMatch(/routeId|userId|controller/i);
  });
});
