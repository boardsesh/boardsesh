// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLedStripes, DEFAULT_TNUT_CORNERS, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import type { SprayPhotoCanvasProps } from '../SprayPhotoCanvas';
import type { SprayLookPreviewSource } from '../../../lib/spray/spray-look-preview';

const controls = vi.hoisted(() => ({
  canvas: null as Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'> | null,
  rail: null as ReactNode,
  dialog: null as ReactNode,
  confirm: vi.fn(),
  focused: true,
}));
vi.mock('expo-router', () => ({ useIsFocused: () => controls.focused }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => controls.confirm }));
vi.mock('../SprayPhotoStage', () => ({
  SprayPhotoStage: ({
    canvas,
    fullScreenRail,
    fullScreenDialog,
  }: {
    canvas: typeof controls.canvas;
    fullScreenRail: ReactNode;
    fullScreenDialog: ReactNode;
  }) => {
    controls.canvas = canvas;
    controls.rail = fullScreenRail;
    controls.dialog = fullScreenDialog;
    return null;
  },
}));
vi.mock('../SpraySetupOverlay', () => ({ SpraySetupOverlay: () => null }));
vi.mock('../SprayPointToolbar', () => ({
  SprayPhotoToolButton: ({
    label,
    selected,
    disabled,
    onPress,
  }: {
    label: string;
    selected?: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => createElement('button', { disabled, 'data-selected': String(Boolean(selected)), onClick: onPress }, label),
  SprayUndoButton: ({ disabled, onPress }: { disabled: boolean; onPress: () => void }) =>
    createElement('button', { disabled, 'data-icon': 'undo', onClick: onPress }, 'sprayLedSetup.undo'),
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Modal: ({ children }: { children?: ReactNode }) => createElement('div', { role: 'dialog' }, children),
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { max?: number; count?: number }) =>
      options?.max !== undefined
        ? `${key}:${options.max}`
        : options?.count !== undefined
          ? `${key}:${options.count}`
          : key,
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    spacing: [0, 4, 8, 12, 16],
    systemColors: { background: '#fff' },
    brandColors: { primary: '#628', error: '#900' },
  }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress: () => void }) =>
    createElement('button', { disabled, onClick: onPress }, title),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: { key: string; label: string }[];
    onSelect: (key: string) => void;
  }) =>
    createElement(
      'div',
      null,
      options.map((option) =>
        createElement('button', { key: option.key, onClick: () => onSelect(option.key) }, option.label),
      ),
    ),
}));
vi.mock('../../board-discovery/BoardMetaFields', () => ({
  BuilderTextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    accessibilityLabel: string;
  }) =>
    createElement('input', {
      value,
      'aria-label': accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));
import { SprayLedStripeEditor } from '../SprayLedStripeEditor';

const source: SprayLookPreviewSource = {
  layoutId: 12,
  versionId: 34,
  photoUrl: '',
  photoExpiresAt: '',
  photo: { width: 500, height: 700 },
  frame: { width: 500, height: 700 },
  homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  holds: [],
};
function fixture(count = 3, orientation: 'horizontal' | 'vertical' = 'vertical') {
  const draft = createLedStripes(
    {
      version: 1,
      photoKey: 'frame',
      pattern: 'grid',
      rows: 2,
      columns: 2,
      corners: DEFAULT_TNUT_CORNERS,
      firstRowOffset: false,
      holes: [],
    },
    orientation,
    count,
  );
  if (draft === 'capacity') throw new Error('fixture too large');
  return draft;
}
function wired(): TnutLayout {
  const layout = fixture();
  const [first, second] = layout.ledStripes!.stripes;
  return {
    ...layout,
    wiring: {
      direction: 'custom',
      startCorner: 'br',
      initialSkip: 2,
      paths: [[...first.ledIds, ...second.ledIds]],
      skips: [{ from: first.ledIds.at(-1)!, to: second.ledIds[0], count: 4 }],
    },
  };
}
const updates: Partial<TnutLayout>[] = [];
function Harness({ initial = fixture() }: { initial?: TnutLayout }) {
  const [layout, setLayout] = useState(initial);
  return (
    <SprayLedStripeEditor
      layout={layout}
      source={source}
      photoUri="file:///photo"
      width={400}
      defaultCount={3}
      onInteractionChange={vi.fn()}
      onChange={(update) => {
        updates.push(update);
        setLayout((previous) => ({ ...previous, ...update }));
      }}
    />
  );
}
const button = (key: string) => screen.getByRole('button', { name: `sprayLedSetup.${key}` });
function tap(point: { x: number; y: number }) {
  act(() => controls.canvas?.onTap?.(point, 500, 700));
}
function chooseFirst(initial: TnutLayout) {
  fireEvent.click(button('stripeSelect'));
  const stripe = initial.ledStripes!.stripes[0];
  tap({ x: (stripe.start.x + stripe.end.x) / 2, y: (stripe.start.y + stripe.end.y) / 2 });
}
async function setCount(count: string) {
  fireEvent.click(button('stripeEditCount'));
  fireEvent.change(screen.getByRole('textbox', { name: 'sprayLedSetup.stripeCount' }), { target: { value: count } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'sprayLed.confirm' })));
}
beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  controls.confirm.mockResolvedValue(true);
  controls.focused = true;
});
afterEach(cleanup);

describe('SprayLedStripeEditor', () => {
  it('starts with tools inactive and selects strips without changing them', () => {
    const initial = fixture();
    render(<Harness initial={initial} />);
    expect(controls.canvas?.mode).toBe('pan');
    tap({ x: 0.1, y: 0.5 });
    expect(updates).toEqual([]);
    chooseFirst(initial);
    expect(screen.getByText('sprayLedSetup.stripeSelected:3')).toBeTruthy();
    expect(updates).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'sprayLed.title' }));
    expect(controls.canvas?.mode).toBe('pan');
  });

  it.each(['horizontal', 'vertical'] as const)(
    'moves an endpoint of the first %s strip with IDs and cable intact',
    (orientation) => {
      const initial = { ...fixture(3, orientation), wiring: wired().wiring };
      render(<Harness initial={initial} />);
      fireEvent.click(button('movePoint'));
      const first = initial.ledStripes!.stripes[0];
      act(() => controls.canvas?.onMove?.(first.start, { x: 0.2, y: 0.2 }, 500, 700));
      expect(updates.at(-1)?.ledStripes?.stripes[0].start).toEqual({ x: 0.2, y: 0.2 });
      expect(updates.at(-1)?.ledStripes?.stripes.map((stripe) => stripe.ledIds)).toEqual(
        initial.ledStripes!.stripes.map((stripe) => stripe.ledIds),
      );
      expect(updates.at(-1)?.wiring).toEqual(initial.wiring);
      expect(controls.confirm).not.toHaveBeenCalled();
      fireEvent.click(button('undo'));
      expect(updates.at(-1)?.ledPositions).toEqual(initial.ledPositions);
    },
  );

  it('changes only the chosen count and cancels or undoes cable clearing atomically', async () => {
    const initial = wired();
    render(<Harness initial={initial} />);
    chooseFirst(initial);
    controls.confirm.mockResolvedValueOnce(false);
    await setCount('5');
    expect(updates).toEqual([]);
    await setCount('5');
    expect(controls.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'sprayLedSetup.clearCableTitle' }));
    expect(updates.at(-1)?.ledStripes?.stripes.map((stripe) => stripe.ledIds.length)).toEqual([5, 3]);
    expect(updates.at(-1)?.wiring).toBeUndefined();
    fireEvent.click(button('undo'));
    expect(updates.at(-1)?.wiring).toEqual(initial.wiring);
    expect(updates.at(-1)?.ledStripes).toEqual(initial.ledStripes);
  });

  it('adds and removes a strip, keeping the other strip identities', async () => {
    const initial = fixture();
    render(<Harness initial={initial} />);
    fireEvent.click(button('add'));
    tap({ x: 0.5, y: 0.1 });
    expect(screen.getByText('sprayLedSetup.stripePickEnd')).toBeTruthy();
    await act(async () => tap({ x: 0.5, y: 0.9 }));
    expect(updates.at(-1)?.ledStripes?.stripes).toHaveLength(3);
    fireEvent.click(button('remove'));
    await act(async () => tap({ x: 0.5, y: 0.5 }));
    expect(updates.at(-1)?.ledStripes?.stripes).toEqual(initial.ledStripes!.stripes);
  });

  it('separates endpoint gestures from individual LED gestures and preserves moved offsets on add/remove', async () => {
    const initial = wired();
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: 'sprayLed.title' }));
    fireEvent.click(button('movePoint'));
    const firstLed = initial.ledPositions![0];
    act(() => controls.canvas?.onMove?.(firstLed, { x: 0.18, y: 0.15 }, 500, 700));
    const moved = updates.at(-1)!;
    expect(moved.ledStripes).toEqual(initial.ledStripes);
    expect(moved.wiring).toEqual(initial.wiring);
    fireEvent.click(button('add'));
    await act(async () => tap({ x: 0.13, y: 0.35 }));
    expect(updates.at(-1)?.ledPositions).toContainEqual({ ...firstLed, x: 0.18, y: 0.15 });
    const added = updates.at(-1)!.ledPositions!.find((led) => !initial.ledPositions!.some((old) => old.id === led.id))!;
    fireEvent.click(button('remove'));
    await act(async () => tap(added));
    expect(updates.at(-1)?.ledPositions).toEqual(moved.ledPositions);
  });

  it('shows the actual remaining capacity inside the count dialog', () => {
    const initial = fixture(3000);
    render(<Harness initial={initial} />);
    chooseFirst(initial);
    fireEvent.click(button('stripeEditCount'));
    expect(screen.getByText('sprayLedSetup.stripeCountRange:3000')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'sprayLedSetup.stripeCount' }), { target: { value: '3001' } });
    expect((screen.getByRole('button', { name: 'sprayLed.confirm' }) as HTMLButtonElement).disabled).toBe(true);
    expect(updates).toEqual([]);
  });

  it('offers icon tools and exactly one count dialog from fullscreen', () => {
    controls.focused = false;
    const initial = fixture();
    render(<Harness initial={initial} />);
    const rail = render(createElement('div', null, controls.rail));
    fireEvent.click(within(rail.container).getByText('sprayLedSetup.stripeSelect'));
    tap({ x: initial.ledStripes!.stripes[0].start.x, y: 0.5 });
    rail.rerender(createElement('div', null, controls.rail));
    fireEvent.click(within(rail.container).getByText('sprayLedSetup.stripeEditCount'));
    expect(screen.queryByRole('dialog')).toBeNull();
    const dialog = render(createElement('div', null, controls.dialog));
    expect(within(dialog.container).getAllByRole('dialog')).toHaveLength(1);
    expect(within(rail.container).getByText('sprayLedSetup.undo').getAttribute('data-icon')).toBe('undo');
  });
});
