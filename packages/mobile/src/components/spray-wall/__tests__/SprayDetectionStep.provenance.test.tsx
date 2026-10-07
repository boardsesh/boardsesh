// @vitest-environment jsdom
//
// Training provenance starts here (SW-20, #5471): every find leaves the step
// stamped with its run and its index in the run's FULL list, so a find the seed
// later drops below the maybe floor cannot shift the indices of the rest.
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SPRAY_MAYBE_FLOOR } from '@boardsesh/shared-schema';

const detection = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../../lib/spray/use-spray-detection', () => ({
  useSprayDetection: () => ({
    query: { data: detection.current, isError: false },
    retry: { mutate: vi.fn(), isPending: false, isError: false },
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/analytics', () => ({ sprayWallDetectionFinished: (properties: unknown) => ({ properties }) }));
vi.mock('../../../lib/spray/spray-telemetry', () => ({ trackSprayEvent: vi.fn() }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({ Button: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../SprayScanPhoto', () => ({ SprayScanPhoto: () => null }));

import { SprayDetectionStep } from '../SprayDetectionStep';

describe('SprayDetectionStep', () => {
  it('stamps every find with the run id and its index in the full list', () => {
    const candidates = [
      { cx: 10, cy: 10, r: 5, confidence: 0.9 },
      { cx: 20, cy: 20, r: 5, confidence: SPRAY_MAYBE_FLOOR - 0.1 },
      { cx: 30, cy: 30, r: 5, confidence: 0.7, outline: [1, 0, 0, 1, -1, 0] },
    ];
    detection.current = {
      id: 'detection-9',
      status: 'done',
      createdAt: '2026-10-07T10:00:00.000Z',
      finishedAt: '2026-10-07T10:00:05.000Z',
      result: { width: 100, height: 100, candidates },
    };
    const onComplete = vi.fn();
    render(createElement(SprayDetectionStep, { wallUuid: 'wall-1', versionId: 'v-1', onComplete }));

    expect(onComplete).toHaveBeenCalledExactlyOnceWith([
      { ...candidates[0], detectionId: 'detection-9', index: 0 },
      { ...candidates[1], detectionId: 'detection-9', index: 1 },
      { ...candidates[2], detectionId: 'detection-9', index: 2 },
    ]);
  });
});
