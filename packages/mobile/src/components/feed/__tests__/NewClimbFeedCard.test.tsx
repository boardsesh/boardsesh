// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ActivityFeedItem } from '@boardsesh/shared-schema';
import { NewClimbFeedCard } from '../NewClimbFeedCard';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  open: vi.fn(),
  thumbnail: vi.fn(),
  carousel: vi.fn(),
  snap: { current: undefined as ((index: number) => void) | undefined },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number; setter?: string }) =>
      params ? `${key}:${params.count ?? params.setter}` : key,
  }),
}));
vi.mock('react-native', () => ({
  Platform: {
    OS: 'android',
    select: (options: { android?: unknown; default?: unknown }) => options.android ?? options.default,
  },
  View: ({
    children,
    onLayout,
    style,
  }: {
    children?: ReactNode;
    onLayout?: (event: unknown) => void;
    style?: unknown;
  }) => (
    // Report a width the moment the slot mounts, the way the native onLayout
    // does — without it the card would never leave its unmeasured branch. The
    // style rides along as data so a test can see which page dot is lit.
    <div data-style={JSON.stringify(style ?? null)} ref={() => onLayout?.({ nativeEvent: { layout: { width: 320 } } })}>
      {children}
    </div>
  ),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
}));
vi.mock('../../Card', () => ({ Card: ({ children }: { children?: ReactNode }) => <section>{children}</section> }));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('../../Icon', () => ({ Icon: () => <i /> }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button onClick={onPress} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock('../../PressableAvatar', () => ({
  PressableAvatar: ({ name }: { name?: string | null }) => <img alt={name ?? ''} />,
}));
vi.mock('../../ClimbListThumbnail', () => ({
  ClimbListThumbnail: (props: unknown) => {
    mocks.thumbnail(props);
    return <div />;
  },
}));
// The rail is a FlashList; render every page inline so the test can assert what
// the climber can reach by swiping without driving a virtualized scroll.
vi.mock('../../SnapCarousel', () => ({
  SnapCarousel: <TItem,>({
    data,
    renderItem,
    keyExtractor,
    onSnapToIndex,
  }: {
    data: readonly TItem[];
    renderItem: (info: { item: TItem; index: number }) => ReactNode;
    keyExtractor: (item: TItem, index: number) => string;
    onSnapToIndex?: (index: number) => void;
  }) => {
    mocks.carousel(data);
    mocks.snap.current = onSnapToIndex;
    return (
      <div>
        {data.map((item, index) => (
          <div key={keyExtractor(item, index)}>{renderItem({ item, index })}</div>
        ))}
      </div>
    );
  },
}));
vi.mock('../../you/profile-chart-colors', () => ({ gradeBadgeColor: () => '#fff' }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer: vi.fn() }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888', tertiaryLabel: '#aaa', separator: '#333', fill: '#222' },
  }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => (grade === 'V4' ? 'V4' : null) }),
}));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => '1d' }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: mocks.open }));

const climb: ActivityFeedItem = {
  id: 'climb:new',
  type: 'new_climb',
  entityType: 'climb',
  entityId: 'new',
  climbUuid: 'new',
  climbName: 'Fresh holds',
  setterUsername: 'accountless',
  actorId: null,
  actorDisplayName: 'Brian Carlson',
  boardType: 'woods',
  layoutId: 1,
  frames: 'p1r1',
  angle: 40,
  difficultyName: 'V4',
  renderBoard: { layoutId: 1, sizeId: 1, setIds: [1] },
  createdAt: '2026-09-01T12:00:00Z',
};

const single = (overrides: Partial<ActivityFeedItem> = {}) =>
  ({
    __typename: 'CrewClimbItem',
    id: 'climbgroup:woods:accountless:2026-09-01',
    occurredAt: climb.createdAt,
    climb: { ...climb, ...overrides },
  }) as const;

const group = (climbs: ActivityFeedItem[], totalCount = climbs.length) =>
  ({
    __typename: 'CrewClimbGroupItem',
    id: 'climbgroup:woods:accountless:2026-09-01',
    occurredAt: climb.createdAt,
    climbs,
    totalCount,
  }) as const;

const second: ActivityFeedItem = { ...climb, climbUuid: 'second', entityId: 'second', climbName: 'Long scoot' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NewClimbFeedCard', () => {
  it.each(['climbUuid', 'frames'] as const)('does not open an incomplete climb missing %s', (field) => {
    const { getByRole } = render(<NewClimbFeedCard item={single({ [field]: null })} />);
    fireEvent.click(getByRole('button', { name: /Fresh holds/ }));
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('opens the play drawer in place instead of pushing the climb route', () => {
    const { getByRole, getByText } = render(<NewClimbFeedCard item={single()} />);
    expect(mocks.thumbnail).toHaveBeenCalledWith(expect.objectContaining({ boardName: 'woods', sizeId: 1 }));
    fireEvent.click(getByRole('button', { name: /Fresh holds/ }));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith(
      {
        kind: 'climb',
        climb: expect.objectContaining({ uuid: 'new', frames: 'p1r1', name: 'Fresh holds' }),
        boardConfig: { boardName: 'woods', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 },
      },
      expect.anything(),
      { preview: true },
    );
    expect(getByText('V4')).not.toBeNull();
    expect(getByText('40°')).not.toBeNull();
  });

  it('renders no carousel for a lone climb', () => {
    render(<NewClimbFeedCard item={single()} />);
    expect(mocks.carousel).not.toHaveBeenCalled();
  });

  it('drops the grade slot for an ungraded climb rather than showing a bare angle', () => {
    const { getByRole, getByText } = render(<NewClimbFeedCard item={single({ difficultyName: null })} />);
    // The hero's label is the slots it actually rendered, in order: no grade
    // between the name and the angle, and no separator left stranded.
    expect(getByRole('button', { name: /Fresh holds/ }).getAttribute('aria-label')).toBe('Fresh holds, 40°, Woods');
    expect(getByText('40°')).not.toBeNull();
  });

  it('keeps the grade ahead of the angle when there is one', () => {
    const { getByRole } = render(<NewClimbFeedCard item={single()} />);
    expect(getByRole('button', { name: /Fresh holds/ }).getAttribute('aria-label')).toBe('Fresh holds, V4, 40°, Woods');
  });

  it('keeps the raw grade when the climber preferred system cannot express it', () => {
    const { getByText } = render(<NewClimbFeedCard item={single({ difficultyName: '7A' })} />);
    expect(getByText('7A')).not.toBeNull();
  });

  it('swipes between a setter day of climbs under one header', () => {
    const { getByText } = render(<NewClimbFeedCard item={group([climb, second])} />);
    expect(getByText('authors.newClimbCount:2')).not.toBeNull();
    expect(getByText('Fresh holds')).not.toBeNull();
    expect(getByText('Long scoot')).not.toBeNull();
    expect(mocks.carousel).toHaveBeenCalledWith([
      { kind: 'climb', climb },
      { kind: 'climb', climb: second },
    ]);
  });

  it('adds a See all page when the group outran the cap, and it opens the setter', () => {
    const { getByRole } = render(<NewClimbFeedCard item={group([climb, second], 12)} />);
    fireEvent.click(getByRole('button', { name: 'authors.seeAllClimbs:12' }));
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/setter/[username]',
      params: { username: 'accountless' },
    });
  });

  it('leaves out the See all page when the card already holds every climb', () => {
    render(<NewClimbFeedCard item={group([climb, second])} />);
    expect(mocks.carousel).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ kind: 'see-all' })]),
    );
  });

  // FlashList recycles one group cell into the next, so the page index has to be
  // paired with its group or B opens on the page you left A on.
  it('resets the lit dot when the cell is recycled into another group', () => {
    const third: ActivityFeedItem = { ...climb, climbUuid: 'third', entityId: 'third', climbName: 'Sixty percent' };
    const groupA = { ...group([climb, second, third]), id: 'climbgroup:woods:accountless:2026-09-01' };
    const groupB = { ...group([climb, second]), id: 'climbgroup:woods:accountless:2026-08-30' };
    const litIndex = (container: HTMLElement) => {
      const dots = [...container.querySelectorAll('div[data-style]')]
        .map((node) => JSON.parse(node.getAttribute('data-style')!))
        .filter((style) => Array.isArray(style) && style[1]?.backgroundColor);
      return dots.findIndex((style) => style[1].backgroundColor === '#888');
    };
    const { rerender, container } = render(<NewClimbFeedCard item={groupA} />);
    act(() => mocks.snap.current?.(2));
    expect(litIndex(container)).toBe(2);

    rerender(<NewClimbFeedCard item={groupB} />);
    // Group B has only two pages; index 2 would light nothing at all.
    expect(litIndex(container)).toBe(0);
  });

  it('sends See all to the profile when a native author has no setter username', () => {
    const native = { ...climb, setterUsername: null, actorId: 'user-1' };
    const { getByRole } = render(<NewClimbFeedCard item={group([native, second], 12)} />);
    fireEvent.click(getByRole('button', { name: 'authors.seeAllClimbs:12' }));
    expect(mocks.push).toHaveBeenCalledWith({ pathname: '/users/[userId]', params: { userId: 'user-1' } });
  });

  it('drops See all entirely when there is nowhere to send the climber', () => {
    const orphan = { ...climb, setterUsername: null, actorId: null };
    render(<NewClimbFeedCard item={group([orphan, second], 12)} />);
    expect(mocks.carousel).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ kind: 'see-all' })]),
    );
  });

  it('carries the feed ascents and stars into the drawer instead of zeros', () => {
    const { getByRole } = render(<NewClimbFeedCard item={single({ ascensionistCount: 7, qualityAverage: 4.5 })} />);
    fireEvent.click(getByRole('button', { name: /Fresh holds/ }));
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        climb: expect.objectContaining({ ascensionist_count: 7, quality_average: '4.5', stars: 4.5 }),
      }),
      expect.anything(),
      { preview: true },
    );
  });
});
