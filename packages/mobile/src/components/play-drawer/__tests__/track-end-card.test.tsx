// @vitest-environment jsdom
// The end card's copy and layout (#6664, #6238): what it says for each model,
// that it names the climb "Keep going" opens right under that button, and that
// both choices are full-width buttons in one centred stack. The model itself is
// tested in `track-end.test.ts`; this pins the render of it.
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';

type ViewMockProps = { children?: ReactNode; testID?: string };

vi.mock('react-native', () => ({
  View: forwardRef<HTMLDivElement, ViewMockProps>(({ children, testID }, ref) =>
    createElement('div', { ref, 'data-testid': testID }, children),
  ),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: ViewMockProps) => createElement('div', null, children) },
  FadeIn: { duration: () => ({}) },
  useReducedMotion: () => true,
}));
// Echo the key and its options, so the test can read which string and which
// values the card asked for.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, testID, numberOfLines }: { children?: ReactNode; testID?: string; numberOfLines?: number }) =>
    createElement('span', { 'data-testid': testID, 'data-lines': numberOfLines }, children),
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    testID,
    variant,
    style,
  }: {
    title: string;
    testID?: string;
    variant?: string;
    style?: { alignSelf?: string };
  }) =>
    createElement('button', { 'data-testid': testID, 'data-variant': variant, 'data-align': style?.alignSelf }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: () => createElement('div', { 'data-scrim': 'true' }),
}));
vi.mock('../use-announce-body-focus', () => ({ useAnnounceBodyFocus: () => {} }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: { elevatedSurface: '#FFF', separator: '#CCC', label: '#111', secondaryLabel: '#666' },
    m3SurfaceContainers: { high: '#EEE' },
    materialElevation: { level2: {} },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  borderRadius: { lg: 12 },
  overlays: { scrim: 'rgba(0,0,0,0.4)' },
  shadows: { md: {} },
  spacing: { 2: 8, 3: 12, 4: 16 },
}));

import { TrackEndCard } from '../TrackEndCard';
import type { TrackEndCardModel } from '../track-end';

const target = { uuid: 'queue-crimp', climb: { uuid: 'crimp', name: 'Crimp Ladder' } } as unknown as ClimbQueueItem;

function renderCard(model: Partial<TrackEndCardModel> = {}) {
  return render(
    createElement(TrackEndCard, {
      model: {
        listName: 'Projects',
        upNextCount: 3,
        firstUpNextName: 'Crimp Ladder',
        action: { kind: 'nextInQueue', target },
        ...model,
      },
      onKeepGoing: vi.fn(),
      onDismiss: vi.fn(),
    }),
  );
}

const firstUpNext = (container: HTMLElement) =>
  container.querySelector('[data-testid="play-drawer-track-end-first-up-next"]');
const keepGoing = (container: HTMLElement) =>
  container.querySelector('[data-testid="play-drawer-track-end-keep-going"]');
const stay = (container: HTMLElement) => container.querySelector('[data-testid="play-drawer-track-end-stay"]');

/** True when `first` comes before `second` in document order. */
const precedes = (first: Element | null, second: Element | null) =>
  first != null && second != null && (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('TrackEndCard', () => {
  it('names the first Up next climb beside the count', () => {
    const { container } = renderCard();

    expect(container.querySelector('[data-testid="play-drawer-track-end-keep-going"]')?.textContent).toBe(
      'playView.track.end.keepGoing {"upNextCount":3}',
    );
    expect(firstUpNext(container)?.textContent).toBe('playView.track.end.firstUpNext {"name":"Crimp Ladder"}');
    // A long name wraps once and then ellipsizes, so the card never grows tall.
    expect(firstUpNext(container)?.getAttribute('data-lines')).toBe('2');
  });

  it('stacks title, Keep going, what it opens, then Stay here', () => {
    const { container, getByText } = renderCard();
    const title = getByText('playView.track.end.title {"name":"Projects"}');

    expect(precedes(title, keepGoing(container))).toBe(true);
    expect(precedes(keepGoing(container), firstUpNext(container))).toBe(true);
    expect(precedes(firstUpNext(container), stay(container))).toBe(true);
  });

  it('draws both choices as full-width buttons, Stay here included', () => {
    const { container } = renderCard();

    expect(keepGoing(container)?.getAttribute('data-variant')).toBe('filled');
    expect(keepGoing(container)?.getAttribute('data-align')).toBe('stretch');
    // A tonal capsule, not a bare text button, so it reads as tappable.
    expect(stay(container)?.getAttribute('data-variant')).toBe('tonal');
    expect(stay(container)?.getAttribute('data-align')).toBe('stretch');
  });

  it("keeps today's wording when there is no name to show", () => {
    const { container } = renderCard({ firstUpNextName: null });

    expect(firstUpNext(container)).toBeNull();
    expect(container.querySelector('[data-testid="play-drawer-track-end-keep-going"]')?.textContent).toBe(
      'playView.track.end.keepGoing {"upNextCount":3}',
    );
  });

  it('names nothing and offers no queue when the list was the end of it', () => {
    const { container } = renderCard({ upNextCount: 0, firstUpNextName: null, action: null });

    expect(firstUpNext(container)).toBeNull();
    expect(container.querySelector('[data-testid="play-drawer-track-end-keep-going"]')).toBeNull();
    expect(container.textContent).toContain('playView.track.end.finished');
    // Stay here is still a full-width button on its own.
    expect(stay(container)?.getAttribute('data-variant')).toBe('tonal');
    expect(stay(container)?.getAttribute('data-align')).toBe('stretch');
  });
});
