// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Minimal RN surface. The horizontal ScrollView renders as a tagged div so the
// tests can assert which controls ride the scroller and which stay pinned
// outside it — the whole point of the row's layout.
type PressMockProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
const announceSpy = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children, onPress, accessibilityLabel }: PressMockProps) =>
    createElement('button', { onClick: onPress, 'data-label': accessibilityLabel }, children),
  ScrollView: ({ children, horizontal }: { children?: ReactNode; horizontal?: boolean }) =>
    createElement('div', { 'data-scroll': 'true', 'data-horizontal': horizontal ? 'true' : 'false' }, children),
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
vi.mock('../../Button', () => ({
  Button: ({ title, disabled, minHeight }: { title?: string; disabled?: boolean; minHeight?: number }) =>
    createElement('button', {
      'data-save-button': 'true',
      'data-title': title,
      'data-min-height': minHeight,
      disabled,
    }),
}));
vi.mock('../../Button.surface', () => ({
  ButtonSurfaceProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({
  ActionButton: ({ iconName, accessibilityLabel }: { iconName?: string; accessibilityLabel?: string }) =>
    createElement('button', { 'data-action': iconName, 'data-label': accessibilityLabel }),
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
    brandColors: { warning: '#B45309', error: '#C81E1E' },
  }),
}));
vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#6D28D9', success: '#047857' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { md: 8 } }));

import { CreateDrawerActionBar } from '../CreateDrawerActionBar';
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
  onNewClimb: vi.fn(),
  frameCount: 1,
  currentFrameIndex: 0,
  canSetActive: true,
  onSetActive: vi.fn(),
  saveState: 'ready' as const,
  onSave: vi.fn(),
  publishBlocked: false,
  draftStatus: null as DraftStatusView | null,
};

function renderBar(frameCount: number, overrides: Partial<typeof baseProps> = {}) {
  const { container } = render(createElement(CreateDrawerActionBar, { ...baseProps, frameCount, ...overrides }));
  return {
    container,
    statusRow: container.querySelector('[data-testid="create-draft-status-row"]') as HTMLElement,
    scroller: container.querySelector('[data-scroll="true"]') as HTMLElement,
    undo: container.querySelector('[data-action="undo"]') as HTMLElement,
    setActive: container.querySelector('[data-action="queue"]') as HTMLElement,
    save: container.querySelector('[data-save-button="true"]') as HTMLElement,
  };
}

describe('CreateDrawerActionBar', () => {
  beforeEach(() => {
    announceSpy.mockClear();
  });

  it('pins Set Active and Save outside the scrolling editing cluster', () => {
    const { scroller, setActive, save } = renderBar(1);

    expect(scroller.getAttribute('data-horizontal')).toBe('true');
    expect(setActive).toBeTruthy();
    expect(save).toBeTruthy();
    expect(scroller.contains(setActive)).toBe(false);
    expect(scroller.contains(save)).toBe(false);
    // The editing actions are the part allowed to scroll.
    expect(scroller.querySelector('[data-action="redo"]')).toBeTruthy();
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

  it('pins undo outside the scroller so recovery survives a crowded row', () => {
    // Nine 44dp controls need ~460dp and the scroller has ~261dp, so undo used to
    // scroll off the left edge the moment a climb had a second frame — putting the
    // only recovery from a mis-tap out of reach exactly when the row got crowded.
    const { scroller, undo } = renderBar(3);

    expect(undo).toBeTruthy();
    expect(scroller.contains(undo)).toBe(false);
    // Redo is the one that may scroll.
    expect(scroller.querySelector('[data-action="redo"]')).toBeTruthy();
  });

  it('keeps the trash glyph for Clear holds and adds a separate Start-a-new-climb', () => {
    // Two buttons, two jobs. `eraser` is not available for Clear holds — it is
    // already the Erase BRUSH chip in the row above, and one glyph can't mean both
    // a mode you enter and a destructive command you fire.
    const { container, scroller } = renderBar(1);

    const clear = container.querySelector('[data-action="delete"]') as HTMLElement;
    const newClimb = container.querySelector('[data-action="plus"]') as HTMLElement;
    expect(clear).toBeTruthy();
    expect(clear.getAttribute('data-label')).toBe('mobile.create.actions.clear');
    expect(newClimb).toBeTruthy();
    expect(newClimb.getAttribute('data-label')).toBe('mobile.create.actions.newClimb');
    expect(container.querySelector('[data-action="eraser"]')).toBeNull();
    // "Start a new climb" is the least-used control, so it's the one that scrolls.
    expect(scroller.contains(newClimb)).toBe(true);
  });

  it('floors the Save pill at the 44dp touch target', () => {
    // Compose sizes a small filled button at 40 — the only sub-floor control on
    // this surface, shoulder to shoulder with 44dp icon buttons.
    const { save } = renderBar(1);
    expect(save.getAttribute('data-min-height')).toBe('44');
  });

  it('disables Save while a publish is blocked, and renders the reason under it', () => {
    const { save, container } = renderBar(1, {
      publishBlocked: true,
      draftStatus: { text: 'mobile.create.publish.blocked', tone: 'warning', announce: true },
    });

    expect((save as HTMLButtonElement).disabled).toBe(true);
    // A disabled button must never be mute.
    expect(container.textContent).toContain('mobile.create.publish.blocked');
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

  it('keeps Set Active and Save pinned even on a route', () => {
    // The scroller used to clip its own controls once a climb had a second
    // frame. Now that frame editing has left it entirely, the trailing pair
    // still has to hold its position at any frame count.
    const { scroller, setActive, save } = renderBar(3);

    expect(scroller.contains(setActive)).toBe(false);
    expect(scroller.contains(save)).toBe(false);
  });

  it('speaks the new count when a frame is ADDED, and stays silent on navigation or delete', () => {
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

    // A delete moves the count DOWN; the status line speaks for that, not this.
    rerender(bar(1, 0));
    expect(announceSpy).toHaveBeenCalledTimes(1);
  });

  it('labels Set Active with a queue glyph, not a play glyph', () => {
    // A play glyph on a button that does not play is half of "the play button
    // doesn't work"; `flash` is the flashed-ascent glyph elsewhere in the app.
    const { setActive } = renderBar(3);
    expect(setActive).toBeTruthy();
    expect(document.querySelector('[data-action="play.circle"]')).toBeNull();
  });
});
