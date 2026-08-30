import { describe, expect, it } from 'vitest';
import { QUANTUM_MODELS } from '@boardsesh/board-constants/quantum';
import {
  getQuantumBoardDetails,
  getQuantumModelForConfig,
  getQuantumModelPickerLabel,
  getQuantumNeutralGrid,
} from '../quantum-config';

describe('Quantum neutral geometry', () => {
  it('resolves only the five exact model layout/size pairs', () => {
    for (const [key, model] of Object.entries(QUANTUM_MODELS)) {
      expect(getQuantumModelForConfig(model.layoutId, model.sizeId)).toEqual({ key, model });
    }
    expect(getQuantumModelForConfig(QUANTUM_MODELS.xl.layoutId, QUANTUM_MODELS.l.sizeId)).toBeNull();
    expect(getQuantumModelForConfig(1, 1)).toBeNull();
  });

  it('uses advertised columns and rows for a neutral canvas without art metadata', () => {
    expect(getQuantumNeutralGrid(9101, 9201)).toEqual({
      model: 'xl',
      columns: 15,
      rows: 15,
      boardWidth: 1500,
      boardHeight: 1500,
    });
    expect(getQuantumNeutralGrid(9102, 9202)).toMatchObject({ columns: 15, rows: 12 });
    expect(getQuantumNeutralGrid(9104, 9204)).toMatchObject({ columns: 8, rows: 12 });
  });

  it('provides the compact XL/L/M/S/Belay model-picker labels', () => {
    expect(Object.values(QUANTUM_MODELS).map((model) => getQuantumModelPickerLabel(model.layoutId))).toEqual([
      'XL',
      'L',
      'M',
      'S',
      'Belay',
    ]);
    expect(getQuantumModelPickerLabel(1)).toBeNull();
  });

  it('projects canonical placement ids and coordinates onto the neutral canvas', () => {
    const details = getQuantumBoardDetails({
      layoutId: 9103,
      sizeId: 9203,
      edgeLeft: 10,
      edgeRight: 22,
      edgeBottom: 30,
      edgeTop: 42,
      placements: [
        { id: 3_000_001, x: 10, y: 30 },
        { id: 3_000_002, x: 16, y: 36 },
        { id: 3_000_003, x: 22, y: 42 },
      ],
    });

    expect(details).toMatchObject({
      board_name: 'quantum',
      layout_id: 9103,
      size_id: 9203,
      boardWidth: 1200,
      boardHeight: 1200,
      edge_left: 10,
      edge_right: 22,
      edge_bottom: 30,
      edge_top: 42,
      images_to_holds: {},
    });
    expect(details?.holdsData).toEqual([
      { id: 3_000_001, mirroredHoldId: null, cx: 0, cy: 1200, r: 18 },
      { id: 3_000_002, mirroredHoldId: null, cx: 600, cy: 600, r: 18 },
      { id: 3_000_003, mirroredHoldId: null, cx: 1200, cy: 0, r: 18 },
    ]);
  });

  it('fails closed for absent, malformed, duplicate, or mismatched geometry', () => {
    const valid = {
      layoutId: 9105,
      sizeId: 9205,
      edgeLeft: 0,
      edgeRight: 8,
      edgeBottom: 0,
      edgeTop: 12,
      placements: [{ id: 5_000_001, x: 1, y: 1 }],
    } as const;

    expect(getQuantumBoardDetails({ ...valid, placements: [] })).toBeNull();
    expect(getQuantumBoardDetails({ ...valid, edgeRight: 0 })).toBeNull();
    expect(getQuantumBoardDetails({ ...valid, layoutId: 9104 })).toBeNull();
    expect(getQuantumBoardDetails({ ...valid, placements: [{ id: 1, x: 9, y: 1 }] })).toBeNull();
    expect(
      getQuantumBoardDetails({
        ...valid,
        placements: [
          { id: 1, x: 1, y: 1 },
          { id: 1, x: 2, y: 2 },
        ],
      }),
    ).toBeNull();
  });
});
