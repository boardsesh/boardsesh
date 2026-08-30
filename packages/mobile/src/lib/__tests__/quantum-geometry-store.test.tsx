// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QUANTUM_MODELS } from '@boardsesh/board-constants/quantum';
import {
  getQuantumGeometry,
  getQuantumGeometryBoardDetails,
  hasCompleteQuantumGeometryCatalog,
  registerQuantumGeometry,
  unregisterQuantumGeometry,
  useQuantumGeometry,
} from '../quantum-geometry-store';

function geometryFor(model: (typeof QUANTUM_MODELS)[keyof typeof QUANTUM_MODELS], revision = 'rev-1') {
  return {
    layoutId: model.layoutId,
    sizeId: model.sizeId,
    revision,
    edgeLeft: 0,
    edgeRight: model.columns * 1_000,
    edgeBottom: 0,
    edgeTop: model.rows * 1_000,
    placements: [
      { placementId: model.layoutId * 1_000, holeId: model.layoutId * 1_000, x: 1_000, y: 1_000, ledPosition: 7 },
    ],
  };
}

afterEach(() => {
  for (const model of Object.values(QUANTUM_MODELS)) unregisterQuantumGeometry(model.layoutId, model.sizeId);
});

describe('Quantum geometry registry', () => {
  it('registers a valid model and exposes projected render details', () => {
    const registration = geometryFor(QUANTUM_MODELS.xl);
    expect(registerQuantumGeometry(registration)).toBe(true);
    expect(getQuantumGeometry(9101, 9201)?.revision).toBe('rev-1');
    expect(getQuantumGeometryBoardDetails(9101, 9201)).toMatchObject({
      board_name: 'quantum',
      boardWidth: 1500,
      boardHeight: 1500,
    });
  });

  it('keeps the last known-good geometry when a replacement is invalid', () => {
    expect(registerQuantumGeometry(geometryFor(QUANTUM_MODELS.m))).toBe(true);
    expect(
      registerQuantumGeometry({
        ...geometryFor(QUANTUM_MODELS.m, 'bad'),
        placements: [{ placementId: 1, holeId: 1, x: 1_000, y: 1_000, ledPosition: 65_536 }],
      }),
    ).toBe(false);
    expect(getQuantumGeometry(9103, 9203)?.revision).toBe('rev-1');
  });

  it('reactively publishes registration and removal for the selected model', () => {
    const { result } = renderHook(() => useQuantumGeometry(9104, 9204));
    expect(result.current).toBeNull();

    act(() => {
      registerQuantumGeometry(geometryFor(QUANTUM_MODELS.s));
    });
    expect(result.current?.revision).toBe('rev-1');

    act(() => unregisterQuantumGeometry(9104, 9204));
    expect(result.current).toBeNull();
  });

  it('opens the picker gate only after all five model geometries are present', () => {
    expect(hasCompleteQuantumGeometryCatalog()).toBe(false);
    for (const model of Object.values(QUANTUM_MODELS)) registerQuantumGeometry(geometryFor(model));
    expect(hasCompleteQuantumGeometryCatalog()).toBe(true);
  });
});
