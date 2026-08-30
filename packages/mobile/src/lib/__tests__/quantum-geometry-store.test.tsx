// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QUANTUM_MODELS, QUANTUM_GEOMETRY_SHA256 } from '@boardsesh/board-constants/quantum';
import {
  getQuantumGeometry,
  getQuantumGeometryBoardDetails,
  getQuantumGeometryGeneration,
  hasCompleteQuantumGeometryCatalog,
  useQuantumGeometry,
} from '../quantum-geometry-store';

describe('fixed bundled Quantum geometry', () => {
  it('has all supported models immediately without network or SQLite hydration', () => {
    expect(hasCompleteQuantumGeometryCatalog()).toBe(true);
    for (const model of Object.values(QUANTUM_MODELS)) {
      const geometry = getQuantumGeometry(model.layoutId, model.sizeId);
      expect(geometry?.revision).toBe(QUANTUM_GEOMETRY_SHA256);
      expect(geometry?.placements.length).toBeGreaterThan(0);
      expect(getQuantumGeometryGeneration(model.layoutId, model.sizeId)).toBeGreaterThan(0);
    }
    expect(getQuantumGeometry(9104, 9201)).toBeNull();
    expect(getQuantumGeometry(9102, 9202)).toBeNull();
  });
  it('keeps the physical hold and LED data immutable and memoized', () => {
    const geometry = getQuantumGeometry(9101, 9201)!;
    expect(Object.isFrozen(geometry)).toBe(true);
    expect(Object.isFrozen(geometry.placements)).toBe(true);
    expect(Object.isFrozen(geometry.placements[0])).toBe(true);
    expect(getQuantumGeometry(9101, 9201)).toBe(geometry);
    expect(getQuantumGeometryBoardDetails(9101, 9201)).toBe(getQuantumGeometryBoardDetails(9101, 9201));
    const firstLed = geometry.placements[0]!.ledPosition;
    expect(() => {
      (geometry.placements[0] as { ledPosition: number }).ledPosition = 99;
    }).toThrow();
    expect(geometry.placements[0]!.ledPosition).toBe(firstLed);
  });
  it('shares the same physical placement identities across standard sizes', () => {
    const xl = new Map(
      getQuantumGeometry(9101, 9201)!.placements.map((placement) => [placement.placementId, placement]),
    );
    const medium = getQuantumGeometry(9101, 9202)!;
    const small = getQuantumGeometry(9101, 9203)!;
    expect(xl.size).toBe(657);
    expect(medium.placements).toHaveLength(549);
    expect(small.placements).toHaveLength(432);
    for (const placement of [...medium.placements, ...small.placements])
      expect(placement).toEqual(xl.get(placement.placementId));
  });
  it('reads the selected fixed size synchronously and respects disabled consumers', () => {
    const { result, rerender } = renderHook(({ enabled, sizeId }) => useQuantumGeometry(9101, sizeId, enabled), {
      initialProps: { enabled: true, sizeId: 9201 },
    });
    expect(result.current?.placements).toHaveLength(657);
    rerender({ enabled: true, sizeId: 9202 });
    expect(result.current?.placements).toHaveLength(549);
    rerender({ enabled: false, sizeId: 9202 });
    expect(result.current).toBeNull();
  });
});
