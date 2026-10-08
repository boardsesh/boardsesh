// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Minimal RN surface.
type PressMockProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
const announceSpy = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children, onPress, accessibilityLabel }: PressMockProps) =>
    createElement('button', { onClick: onPress, 'data-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  AccessibilityInfo: { announceForAccessibility: announceSpy },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Paths are relative to THIS file (one level under the source in __tests__), so
// they carry an extra `../`.
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name?: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({
  ActionButton: ({
    iconName,
    accessibilityLabel,
    checked,
    activeColor,
    accessibilityValueText,
  }: {
    iconName?: string;
    accessibilityLabel?: string;
    checked?: boolean;
    activeColor?: string;
    accessibilityValueText?: string;
  }) =>
    createElement('button', {
      'data-action': iconName,
      'data-label': accessibilityLabel,
      'data-checked': checked == null ? undefined : String(checked),
      'data-active-color': activeColor,
      'data-value': accessibilityValueText,
    }),
  drawerActionBarStyles: { container: {}, rowSecondary: {}, spacer: {} },
}));
vi.mock('../brush-roles', () => ({
  brushRoleColor: () => '#00FF00',
  getPaintRoles: () => ['STARTING', 'HAND', 'FINISH', 'FOOT'],
  useBrushRoleLabels: () => ({ STARTING: 'Start', HAND: 'Hand', FINISH: 'Finish', FOOT: 'Foot' }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/hold-color-overrides', () => ({ useHoldColorOverrides: () => ({ overrides: {} }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#EFEFF0', label: '#000000', secondaryLabel: '#5B5563' },
    brandColors: { warning: '#B45309', error: '#C81E1E', primary: '#A78BFA' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { md: 8 } }));

import { CreateDrawerActionBar } from '../CreateDrawerActionBar';
import { ANNOUNCE_MIN_INTERVAL_MS } from '../use-rate-limited-announcer';
import type { DraftStatusView } from '../draft-status-view';

const baseProps = {
  boardName: 'kilter' as const,
  selectedBrush: 'HAND' as const,
  onSelectBrush: vi.fn(),
  canUndo: true,
  canRedo: true,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onClearHolds: vi.fn(),
  frameCount: 1,
  frameDeletions: 0,
  currentFrameIndex: 0,
  canSetActive: true,
  onSetActive: vi.fn(),
  draftStatus: null as DraftStatusView | null,
};

function renderBar(frameCount: number, overrides: Partial<Parameters<typeof CreateDrawerActionBar>[0]> = {}) {
  const { container } = render(createElement(CreateDrawerActionBar, { ...baseProps, frameCount, ...overrides }));
  return {
    container,
    statusRow: container.querySelector('[data-testid="create-draft-status-row"]') as HTMLElement,
    toolRow: container.querySelector('[data-testid="create-tool-row"]') as HTMLElement,
  };
}

describe('CreateDrawerActionBar', () => {
  beforeEach(() => {
    announceSpy.mockClear();
  });

  it('carries the editing tools and no Save, which is the header confirm', () => {
    // Save moved to the trailing end of the header (top bar everywhere); this
    // row is tools only, spread evenly with no scroller.
    const { toolRow, container } = renderBar(1, { onToggleHeatmap: vi.fn() });
    const actions = Array.from(toolRow.querySelectorAll('[data-action]')).map((node) =>
      node.getAttribute('data-action'),
    );
    expect(actions).toEqual(['undo', 'redo', 'delete', 'flame', 'queue']);
    expect(container.textContent).not.toContain('mobile.create.save');
  });

  it('holds no frame controls at all — the route slot under the board owns those', () => {
    // Duplicate and Delete frame used to sit in here as bare `copy` and
    // `frame.remove` glyphs. Nothing about either said "this turns your boulder
    // into a route" or "this is how you get a third frame", which is what QA
    // declined twice. They live in the route slot now, labelled in words, and
    // one home for frame editing means they must not come back here.
    for (const frameCount of [1, 2, 3]) {
      const { container } = renderBar(frameCount);
      expect(container.querySelector('[data-action="copy"]')).toBeNull();
      expect(container.querySelector('[data-action="frame.remove"]')).toBeNull();
      expect(container.querySelector('[data-action="skip.previous"]')).toBeNull();
      expect(container.querySelector('[data-action="skip.next"]')).toBeNull();
    }
  });

  it('keeps the trash glyph for Clear holds, and no longer carries a plus', () => {
    // `eraser` is not available for Clear holds — it is already the Erase BRUSH
    // chip in the row above, and one glyph can't mean both a mode you enter and a
    // destructive command you fire.
    //
    // The `plus` is gone: "Start a new climb" moved to the header's overflow
    // menu, because on a route screen a `+` that DISCARDS the climb sat a thumb's
    // width from the `+` that adds a frame to it. Two plusses, opposite
    // consequences, one row apart.
    const { container } = renderBar(1);

    const clear = container.querySelector('[data-action="delete"]') as HTMLElement;
    expect(clear).toBeTruthy();
    expect(clear.getAttribute('data-label')).toBe('mobile.create.actions.clear');
    expect(container.querySelector('[data-action="eraser"]')).toBeNull();
    expect(container.querySelector('[data-action="plus"]')).toBeNull();
  });

  it('renders the reason a remix holds Save back in the status line', () => {
    const { container } = renderBar(1, {
      saveBlockedLine: createElement('span', null, 'mobile.lostHolds.editorHint'),
      draftStatus: { text: 'mobile.create.publish.blocked', tone: 'warning', announce: true },
    });

    // A disabled Save (in the header) must never be mute.
    expect(container.querySelector('[data-testid="create-save-blocked-line"]')?.textContent).toContain(
      'mobile.lostHolds.editorHint',
    );
  });

  it('renders no status TEXT for an empty editor, but still holds the row', () => {
    // The words are absent by design — an empty editor has nothing to report.
    // The ROW is not, and that distinction is load-bearing: the drawer sizes the
    // board against the chrome and derives its peek snap-point from the measured
    // above-fold height. When this row appeared only once content existed,
    // painting the FIRST hold grew the chrome, moved `peekHeight`, and re-snapped
    // an expanded sheet back down to peek — a one-shot jolt at exactly the moment
    // someone starts working. Make this row conditional again and that returns.
    const { container, statusRow } = renderBar(1);
    expect(container.textContent).not.toContain('mobile.create.autosave');
    expect(statusRow).toBeTruthy();
  });

  it('holds the same status row whether or not there is anything to say', () => {
    // The chrome height must not depend on content — see above.
    const empty = renderBar(1);
    const withStatus = renderBar(1, {
      draftStatus: { text: 'mobile.create.autosave.onDevice', tone: 'muted', announce: false },
    });

    expect(empty.statusRow).toBeTruthy();
    expect(withStatus.statusRow).toBeTruthy();
    expect(withStatus.statusRow.textContent).toContain('mobile.create.autosave.onDevice');
  });

  it('speaks the new count when a frame is ADDED, and stays silent on navigation', () => {
    // Adding a frame is undoable, so it gets feedback rather than a confirm —
    // the only other sign it worked is the transport's "2 / 2". The button that
    // does it now lives in the route slot, so this keys on the count going UP
    // rather than on a press here; announcing from this component keeps ONE
    // voice on the surface, alongside the draft-status line.
    const bar = (frameCount: number, currentFrameIndex: number) =>
      createElement(CreateDrawerActionBar, { ...baseProps, frameCount, currentFrameIndex });

    const { rerender } = render(bar(1, 0));
    // Mount is not a gain.
    expect(announceSpy).not.toHaveBeenCalled();

    rerender(bar(2, 1));
    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(announceSpy).toHaveBeenLastCalledWith('mobile.create.frames.counter');

    // Stepping between frames moves the INDEX, not the count.
    rerender(bar(2, 0));
    expect(announceSpy).toHaveBeenCalledTimes(1);
  });

  it('speaks a delete off the delete COUNTER, never off the count falling', () => {
    // Three things lower the frame count without a frame being deleted: "Start a
    // new climb" and "Clear holds" both RESET to one empty frame, and undoing an
    // add walks it back. Keying on the count would announce "Frame deleted" for
    // all three, so the controller counts real deletes and this reads that.
    //
    // Fake timers because the announcer is rate-limited to one utterance per
    // ANNOUNCE_MIN_INTERVAL_MS across the whole surface: without advancing them,
    // a second announcement is parked on a timeout and never reaches the spy —
    // which is how the previous version of this test passed while asserting the
    // opposite of what the component did.
    vi.useFakeTimers();
    try {
      const bar = (frameCount: number, frameDeletions: number) =>
        createElement(CreateDrawerActionBar, { ...baseProps, frameCount, frameDeletions, currentFrameIndex: 0 });

      // A reset: four frames collapse to one, and no delete was counted. The
      // timer advance is what makes this assertion mean anything — a parked
      // announcement would otherwise look identical to no announcement.
      const reset = render(bar(4, 0));
      reset.rerender(bar(1, 0));
      vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS);
      expect(announceSpy).not.toHaveBeenCalled();
      reset.unmount();

      // A real delete: the count falls AND the counter moves.
      const deleted = render(bar(4, 0));
      deleted.rerender(bar(3, 1));
      vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS);
      expect(announceSpy).toHaveBeenCalledTimes(1);
      expect(announceSpy).toHaveBeenLastCalledWith('mobile.create.playback.frameDeleted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels Set Active with a queue glyph, not a play glyph', () => {
    // A play glyph on a button that does not play is half of "the play button
    // doesn't work"; `flash` is the flashed-ascent glyph elsewhere in the app.
    const { toolRow } = renderBar(3);
    expect(toolRow.querySelector('[data-action="queue"]')).toBeTruthy();
    expect(document.querySelector('[data-action="play.circle"]')).toBeNull();
  });

  it('reads the flame as a "Heatmap" toggle, tinted with the brand violet and filled while on', () => {
    const { container } = render(
      createElement(CreateDrawerActionBar, { ...baseProps, onToggleHeatmap: vi.fn(), heatmapActive: true }),
    );
    const flame = container.querySelector('[data-action="flame.fill"]');
    expect(flame?.getAttribute('data-label')).toBe('mobile.heatmap.toggle');
    expect(flame?.getAttribute('data-checked')).toBe('true');
    expect(flame?.getAttribute('data-active-color')).toBe('#A78BFA');
    // The heat follows the brush, so the toggle speaks the brush.
    expect(flame?.getAttribute('data-value')).toBe('Hand');
  });

  it('puts the heat line where the autosave note sits while heat is on', () => {
    const { container } = render(
      createElement(CreateDrawerActionBar, {
        ...baseProps,
        draftStatus: { text: 'mobile.create.autosave.onDevice', tone: 'muted', announce: false },
        heatmapLine: createElement('span', null, 'heat legend'),
      }),
    );
    const heatLine = container.querySelector('[data-testid="create-heatmap-line"]');
    expect(heatLine?.textContent).toBe('heat legend');
    // The autosave row stays mounted (for its announcements), outside the heat line's box.
    expect(heatLine?.querySelector('[data-testid="create-draft-status-row"]')).toBeNull();
  });

  it('keeps the heat line up while the status only says what a publish still needs', () => {
    // On a spray wall Save publishes by default, so this hint is up from the
    // first hold until the climb has a start and a finish (#5954 review).
    for (const text of ['mobile.create.publish.blocked']) {
      const { container, unmount } = render(
        createElement(CreateDrawerActionBar, {
          ...baseProps,
          draftStatus: { text, tone: 'warning', announce: true, yieldsToHeatmap: true },
          heatmapLine: createElement('span', null, 'heat legend'),
        }),
      );
      const heatLine = container.querySelector('[data-testid="create-heatmap-line"]');
      expect(heatLine?.textContent).toBe('heat legend');
      // Still mounted, outside the heat line's box, so the hint is announced.
      expect(container.querySelector('[data-testid="create-draft-status-row"]')?.textContent).toContain(text);
      expect(heatLine?.querySelector('[data-testid="create-draft-status-row"]')).toBeNull();
      unmount();
    }
  });

  it('still lets a warning that is not a publish hint win over the heat line', () => {
    const { container } = render(
      createElement(CreateDrawerActionBar, {
        ...baseProps,
        draftStatus: { text: 'mobile.create.autosave.notStored', tone: 'warning', announce: true },
        heatmapLine: createElement('span', null, 'heat legend'),
      }),
    );
    expect(container.querySelector('[data-testid="create-heatmap-line"]')).toBeNull();
  });

  it('lets an urgent draft status win over the heat line', () => {
    const { container } = render(
      createElement(CreateDrawerActionBar, {
        ...baseProps,
        draftStatus: { text: 'mobile.create.autosave.saveFailed', tone: 'error', announce: true },
        heatmapLine: createElement('span', null, 'heat legend'),
      }),
    );
    expect(container.querySelector('[data-testid="create-heatmap-line"]')).toBeNull();
    expect(container.querySelector('[data-testid="create-draft-status-row"]')?.textContent).toContain(
      'mobile.create.autosave.saveFailed',
    );
  });
});
