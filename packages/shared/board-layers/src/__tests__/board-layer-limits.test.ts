import { describe, expect, it } from 'vitest';
import { getBoardCapabilities, LAYERED_WALL_BOARD_NAMES } from '@boardsesh/board-config/capabilities';
import { QUANTUM_MAX_DIODE_IDS, QUANTUM_MAX_PLAYERS } from '@boardsesh/ble-protocol/quantum';
import { BOARD_LAYER_COLORS, MAX_ACTIVE_BOARD_LAYERS, MAX_DIODES_PER_LAYER, MAX_OCCUPIED_PLACEMENTS } from '..';

describe('board layer limits', () => {
  it('derives the generic limits from the layered boards in the capability table', () => {
    const rows = LAYERED_WALL_BOARD_NAMES.map((boardName) => getBoardCapabilities(boardName));
    expect(MAX_ACTIVE_BOARD_LAYERS).toBe(Math.max(...rows.map((row) => row.maxActiveWallClimbs)));
    expect(MAX_DIODES_PER_LAYER).toBe(Math.max(...rows.map((row) => row.maxLightsPerWallClimb ?? 0)));
    expect(MAX_OCCUPIED_PLACEMENTS).toBe(MAX_ACTIVE_BOARD_LAYERS * MAX_DIODES_PER_LAYER);
  });

  it('keeps the values every stored roster and search was bounded by', () => {
    // Redis snapshots, the reportBoardLayers input and the climb search's
    // occupiedPlacementIds were all validated against these numbers.
    expect(MAX_ACTIVE_BOARD_LAYERS).toBe(4);
    expect(MAX_DIODES_PER_LAYER).toBe(92);
    expect(MAX_OCCUPIED_PLACEMENTS).toBe(368);
  });

  it('has a colour for every layer a board can hold', () => {
    expect(BOARD_LAYER_COLORS.length).toBeGreaterThanOrEqual(MAX_ACTIVE_BOARD_LAYERS);
  });
});

describe('Quantum capability row and Bluetooth protocol parity', () => {
  const quantum = getBoardCapabilities('quantum');

  it('matches the roster size the Quantum protocol accepts', () => {
    expect(quantum.maxActiveWallClimbs).toBe(QUANTUM_MAX_PLAYERS);
  });

  it('matches the diode cap the Quantum encoder enforces', () => {
    expect(quantum.maxLightsPerWallClimb).toBe(QUANTUM_MAX_DIODE_IDS);
  });

  it('keeps the generic maxima on Quantum while Quantum-only code reads them', () => {
    // Mobile quantum-climb-lights.ts and quantum-bluetooth-provider.tsx, and the
    // backend's Quantum frame check (validation/schemas/climbs.ts), bound Quantum
    // with the generic MAX_ACTIVE_BOARD_LAYERS / MAX_DIODES_PER_LAYER. A layered
    // board with bigger limits must first move those onto the Quantum row, or
    // Quantum would accept rosters and climbs its protocol rejects.
    expect(MAX_ACTIVE_BOARD_LAYERS).toBe(QUANTUM_MAX_PLAYERS);
    expect(MAX_DIODES_PER_LAYER).toBe(QUANTUM_MAX_DIODE_IDS);
  });
});
