// @vitest-environment jsdom
// The end card's copy (#6664, #6238): what it says for each model, and that it
// names the climb "Keep going" opens. The model itself is tested in
// `track-end.test.ts`; this pins the render of it.
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
  Button: ({ title, testID }: { title: string; testID?: string }) =>
    createElement('button', { 'data-testid': testID }, title),
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
  });
});
