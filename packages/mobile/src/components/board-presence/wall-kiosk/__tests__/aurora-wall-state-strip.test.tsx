// @vitest-environment jsdom
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

vi.mock('../../../../hooks/use-aurora-presence-grades', () => ({
  useAuroraPresenceClimb: (climb: BoardPresenceClimb | null, config: { angle: number } | null) =>
    climb?.source === 'aurora' && config
      ? {
          climb: { ...climb, angle: config.angle, grade: `V${config.angle}` },
          grade: { difficulty: `V${config.angle}` },
        }
      : { climb, grade: undefined },
}));
vi.mock('../../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({
    resolveGrade: (climb: { difficulty?: string | null }) => ({ label: climb.difficulty ?? '', color: '#ff0' }),
  }),
}));
vi.mock('../../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../../lib/spray/use-spray-wall-leds-enabled', () => ({ useSprayWallLedsEnabled: () => false }));
vi.mock('../WallStateStripView', () => ({
  WallStateStripView: (props: { liveResolvedGrade: { label: string } }) =>
    createElement('div', null, props.liveResolvedGrade.label),
}));
import { WallStateStrip } from '../WallStateStrip';

const imported: BoardPresenceClimb = {
  source: 'aurora',
  climbUuid: 'climb',
  angle: null,
  grade: null,
  seq: 1,
  sentAt: '2026-11-17T00:00:00Z',
};
const config = { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 20 };
const props = {
  mode: 'history' as const,
  stepsBack: 1,
  previewTimestamp: null,
  liveClimb: imported,
  typeScale: {
    gradeFontSize: 64,
    gradeLineHeight: 68,
    nameFontSize: 40,
    nameLineHeight: 44,
    metaFontSize: 20,
    metaLineHeight: 26,
    stateFontSize: 20,
    stateLineHeight: 26,
  },
};
describe('Aurora kiosk live state', () => {
  it('projects the live grade while previewing another history event', () => {
    const { getByText, rerender } = render(<WallStateStrip {...props} boardConfig={config} />);
    expect(getByText('V20')).toBeTruthy();
    rerender(<WallStateStrip {...props} boardConfig={{ ...config, angle: 0 }} />);
    expect(getByText('V0')).toBeTruthy();
    expect(imported.angle).toBeNull();
  });
});
