// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What is under test is the step's own bookkeeping: which picture the crop box
// is drawn on after a turn, what edit Done hands over, and which files it
// leaves behind. The crop box itself is a recorder (`SprayCropMarker.test`
// would be the place for its gestures) and the native render is a promise the
// test settles.

type MarkerProps = {
  photo: { uri: string; width: number; height: number };
  value: { left: number; top: number; right: number; bottom: number };
  onChange: (rect: { left: number; top: number; right: number; bottom: number }) => void;
  minSize: { width: number; height: number };
};
const marker = vi.hoisted(() => ({ last: null as MarkerProps | null }));
const renderRotatedPreview = vi.hoisted(() => vi.fn());
const discardLocalPhoto = vi.hoisted(() => vi.fn());
/** What the step last put in its header, through `useHeaderActions`. */
type HeaderActions = {
  leading?: { kind: string; onPress: () => void } | null;
  trailing?: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean } | null;
};
const header = vi.hoisted(() => ({ last: null as HeaderActions | null }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/use-transparent-header-inset', () => ({ useTransparentHeaderInset: () => 0 }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888', separator: '#ddd' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { systemRed: '#FF3B30', systemOrange: '#FF9500', systemBlue: '#007AFF' },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('i', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/spray/discard-local-photo', () => ({ discardLocalPhoto }));
vi.mock('../../../lib/spray/wall-photo', () => ({ WALL_PHOTO_MAX_DIMENSION: 4096, renderRotatedPreview }));
vi.mock('../SprayCropMarker', () => ({
  SprayCropMarker: (props: MarkerProps) => {
    marker.last = props;
    return createElement('div', { 'data-testid': 'crop', 'data-uri': props.photo.uri });
  },
}));
vi.mock('../../../hooks/use-header-actions', () => ({
  useHeaderActions: (actions: HeaderActions) => {
    header.last = actions;
  },
}));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));

const { SprayPhotoAdjustStep } = await import('../SprayPhotoAdjustStep');

// A 12 MP photo: under the 4096 px cap, so the base is the original's size.
const BASE = { uri: 'file:///base.jpg', width: 4032, height: 3024 };
const PHOTO = { ...BASE, base: BASE, original: { uri: 'file:///original.heic', longSide: 4032 }, edit: null };

function renderStep(overrides: Partial<Parameters<typeof SprayPhotoAdjustStep>[0]> = {}) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    createElement(SprayPhotoAdjustStep, {
      title: 'title',
      body: 'body',
      photo: PHOTO,
      processing: false,
      failed: false,
      onDone,
      onCancel,
      ...overrides,
    }),
  );
  return { ...view, onDone, onCancel };
}

/** Done, in the header: checks the label, then presses it. */
function pressDone() {
  const trailing = header.last?.trailing;
  expect(trailing?.label).toBe('sprayWizard.adjust.done');
  act(() => trailing?.onPress());
}

beforeEach(() => {
  marker.last = null;
  header.last = null;
  renderRotatedPreview
    .mockReset()
    .mockImplementation(async (_base: unknown, turns: number) => `file:///turn-${turns}.jpg`);
  discardLocalPhoto.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SprayPhotoAdjustStep', () => {
  it('opens on the base, uncropped, with nothing to reset', () => {
    renderStep();
    expect(marker.last?.photo).toEqual(BASE);
    expect(marker.last?.value).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
    expect(screen.getByText('sprayWizard.adjust.reset').hasAttribute('disabled')).toBe(true);
    expect(renderRotatedPreview).not.toHaveBeenCalled();
  });

  it('reopens on the last edit, drawn on the base turned to match', async () => {
    const edit = { quarterTurns: 1 as const, crop: { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 } };
    renderStep({ photo: { ...PHOTO, edit } });
    await act(async () => {});
    expect(renderRotatedPreview).toHaveBeenCalledWith(BASE, 1);
    // A turned preview of the base, at the base's turned size: the crop box
    // works in the space the climber sees.
    expect(marker.last?.photo).toEqual({ uri: 'file:///turn-1.jpg', width: 3024, height: 4032 });
    expect(marker.last?.value).toEqual(edit.crop);
  });

  it('turns the picture and the crop together, and hands the edit over on Done', async () => {
    const { onDone } = renderStep();
    act(() => marker.last?.onChange({ left: 0.1, top: 0.2, right: 0.7, bottom: 0.9 }));
    // No picture to draw on while the turn renders, so nothing to drag either.
    fireEvent.click(screen.getByText('sprayWizard.adjust.rotate'));
    expect(screen.getByTestId('spinner')).toBeTruthy();
    await act(async () => {});

    expect(marker.last?.photo.uri).toBe('file:///turn-1.jpg');
    const turned = marker.last?.value;
    expect(turned?.left).toBeCloseTo(0.1, 12);
    expect(turned?.top).toBeCloseTo(0.1, 12);
    expect(turned?.right).toBeCloseTo(0.8, 12);
    expect(turned?.bottom).toBeCloseTo(0.7, 12);

    pressDone();
    expect(onDone).toHaveBeenCalledWith({ quarterTurns: 1, crop: turned });
  });

  it('renders each turn once, and reuses it on the way round again', async () => {
    renderStep();
    for (let tap = 0; tap < 4; tap++) {
      fireEvent.click(screen.getByText('sprayWizard.adjust.rotate'));
      await act(async () => {});
    }
    expect(renderRotatedPreview.mock.calls.map(([, turns]) => turns)).toEqual([1, 2, 3]);
    expect(marker.last?.photo.uri).toBe(BASE.uri);
    fireEvent.click(screen.getByText('sprayWizard.adjust.rotate'));
    await act(async () => {});
    expect(renderRotatedPreview).toHaveBeenCalledTimes(3);
  });

  it('puts the photo back as picked on Reset', async () => {
    const { onDone } = renderStep({
      photo: { ...PHOTO, edit: { quarterTurns: 2, crop: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 } } },
    });
    await act(async () => {});
    fireEvent.click(screen.getByText('sprayWizard.adjust.reset'));
    expect(marker.last?.photo).toEqual(BASE);
    pressDone();
    expect(onDone).toHaveBeenCalledWith({ quarterTurns: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } });
  });

  it('cancels from the header, and holds every action while the edit renders', () => {
    const { onCancel, rerender, onDone } = renderStep();
    expect(header.last?.leading?.kind).toBe('cancel');
    act(() => header.last?.leading?.onPress());
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      createElement(SprayPhotoAdjustStep, {
        title: 'title',
        body: 'body',
        photo: PHOTO,
        processing: true,
        failed: false,
        onDone,
        onCancel,
      }),
    );
    expect(header.last?.trailing).toMatchObject({ disabled: true, loading: true });
    act(() => header.last?.leading?.onPress());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText('sprayWizard.adjust.rotate').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('sprayWizard.adjust.reset').hasAttribute('disabled')).toBe(true);
  });

  it('says so when the render failed, and warns about a crop that leaves a small photo', () => {
    const { unmount } = renderStep({ failed: true });
    // The visible slot plus its hidden sizing probe.
    expect(screen.getAllByText('sprayWizard.adjust.failed')).toHaveLength(2);
    unmount();

    renderStep();
    expect(screen.getAllByText('sprayWizard.adjust.small')).toHaveLength(1);
    // A quarter-width, quarter-height crop of a 12 MP photo keeps 1008 px.
    act(() => marker.last?.onChange({ left: 0, top: 0, right: 0.25, bottom: 0.25 }));
    expect(screen.getAllByText('sprayWizard.adjust.small')).toHaveLength(2);
  });

  it('deletes the turned previews it drew when it closes, and never the base', async () => {
    const { unmount } = renderStep();
    fireEvent.click(screen.getByText('sprayWizard.adjust.rotate'));
    await act(async () => {});
    fireEvent.click(screen.getByText('sprayWizard.adjust.rotate'));
    await act(async () => {});
    unmount();
    expect(discardLocalPhoto.mock.calls.map(([uri]) => uri).sort()).toEqual([
      'file:///turn-1.jpg',
      'file:///turn-2.jpg',
    ]);
  });
});
