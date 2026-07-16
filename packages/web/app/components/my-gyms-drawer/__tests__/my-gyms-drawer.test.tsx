import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import MyGymsDrawer from '../my-gyms-drawer';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// jsdom/happy-dom doesn't implement IntersectionObserver, which the infinite-scroll
// hook in MyGymsDrawer instantiates on mount. Provide a no-op stub so the effect
// doesn't throw during render.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;

// Mock data
let mockGyms: Array<Record<string, unknown>> = [];
let mockIsLoading = false;
let mockError: string | null = null;
let mockUserId: string | null = 'user-1';
let mockKioskFlag = true;

vi.mock('@/app/hooks/use-my-gyms', () => ({
  useMyGyms: () => ({
    gyms: mockGyms,
    isLoading: mockIsLoading,
    isFetchingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
    error: mockError,
  }),
}));

vi.mock('@/app/components/providers/feature-flags-provider', () => ({
  useFeatureFlag: () => mockKioskFlag,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockUserId ? { user: { id: mockUserId } } : null }),
}));

vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: ({
    open,
    children,
    title,
    extra,
  }: {
    open: boolean;
    children: React.ReactNode;
    title: React.ReactNode;
    extra?: React.ReactNode;
    onClose: () => void;
  }) =>
    open ? (
      <div data-testid="drawer">
        <div data-testid="drawer-header">
          <span data-testid="drawer-title">{title}</span>
          {extra && <span data-testid="drawer-extra">{extra}</span>}
        </div>
        {children}
      </div>
    ) : null,
}));

vi.mock('../../search-drawer/unified-search-drawer', () => ({
  default: ({ open, defaultCategory }: { open: boolean; defaultCategory?: string }) =>
    open ? (
      <div data-testid="gym-search">
        <span>Category: {defaultCategory}</span>
      </div>
    ) : null,
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../my-gyms-drawer.module.css', () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) => String(prop),
    },
  ),
}));

function makeGym(overrides?: Record<string, unknown>) {
  return {
    uuid: 'gym-1',
    slug: 'boulder-project',
    ownerId: 'user-1',
    name: 'Boulder Project',
    address: '123 Crux St',
    isPublic: true,
    boardCount: 3,
    memberCount: 12,
    followerCount: 8,
    commentCount: 0,
    isFollowedByMe: false,
    isMember: true,
    myRole: 'admin',
    canEdit: true,
    canGrantAccess: true,
    canClaim: false,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('MyGymsDrawer', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGyms = [];
    mockIsLoading = false;
    mockError = null;
    mockUserId = 'user-1';
    mockKioskFlag = true;
  });

  it('does not render when closed', () => {
    render(<MyGymsDrawer open={false} onClose={mockOnClose} />);
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('renders loading state', () => {
    mockIsLoading = true;
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.getByTestId('my-gyms-loading')).toBeDefined();
  });

  it('renders empty state with a find-your-gym action when no gyms', () => {
    mockGyms = [];
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.getByTestId('my-gyms-empty')).toBeDefined();
    expect(screen.getByText(/might already be on Boardsesh/)).toBeDefined();
    expect(screen.getByTestId('my-gyms-find')).toBeDefined();
  });

  it('renders gym list with gyms', () => {
    mockGyms = [makeGym(), makeGym({ uuid: 'gym-2', name: 'Send Town', slug: 'send-town' })];
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.getByTestId('my-gyms-list')).toBeDefined();
    expect(screen.getByText('Boulder Project')).toBeDefined();
    expect(screen.getByText('Send Town')).toBeDefined();
  });

  it('shows the Owner chip when the viewer owns the gym', () => {
    mockUserId = 'user-1';
    mockGyms = [makeGym({ ownerId: 'user-1' })];
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.getByText('Owner')).toBeDefined();
  });

  it('shows the role chip from myRole when the viewer is not the owner', () => {
    mockUserId = 'user-2';
    mockGyms = [makeGym({ ownerId: 'someone-else', myRole: 'editor' })];
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.getByText('Editor')).toBeDefined();
    expect(screen.queryByText('Owner')).toBeNull();
  });

  it('shows Manage and View actions with correct hrefs when canEdit', () => {
    mockGyms = [makeGym({ slug: 'boulder-project', canEdit: true })];
    render(<MyGymsDrawer open onClose={mockOnClose} />);

    const manageLink = screen.getByTestId('gym-manage-gym-1');
    const viewLink = screen.getByTestId('gym-view-gym-1');
    expect(manageLink.getAttribute('href')).toBe('/gym/boulder-project/manage');
    expect(viewLink.getAttribute('href')).toBe('/gym/boulder-project');
  });

  it('hides the Manage action when the viewer cannot edit', () => {
    mockUserId = 'user-2';
    mockGyms = [makeGym({ ownerId: 'someone-else', myRole: 'member', canEdit: false })];
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.queryByTestId('gym-manage-gym-1')).toBeNull();
    expect(screen.getByTestId('gym-view-gym-1')).toBeDefined();
  });

  it('hides Manage behind the gym-kiosk kill switch but keeps View', () => {
    mockKioskFlag = false;
    mockGyms = [makeGym({ slug: 'boulder-project', canEdit: true })];
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.queryByTestId('gym-manage-gym-1')).toBeNull();
    expect(screen.getByTestId('gym-view-gym-1')).toBeDefined();
  });

  it('still renders the row (name + role chip) when the flag is off and the gym is slug-less', () => {
    // Kiosk flag off + no slug: Manage is gated away and View has no slug to link
    // to, so the row carries zero actions — it stays as an informational entry.
    mockKioskFlag = false;
    mockGyms = [makeGym({ slug: null, canEdit: true, ownerId: 'user-1' })];
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.getByTestId('gym-item-gym-1')).toBeDefined();
    expect(screen.getByText('Boulder Project')).toBeDefined();
    expect(screen.getByText('Owner')).toBeDefined();
    expect(screen.queryByTestId('gym-manage-gym-1')).toBeNull();
    expect(screen.queryByTestId('gym-view-gym-1')).toBeNull();
  });

  it('addresses the manage route by uuid but hides View when the slug is null', () => {
    // The manage route resolves a bare UUID (legacy slug-less gyms); the public
    // gym page resolves only by slug, so View has nothing to link to.
    mockGyms = [makeGym({ slug: null, canEdit: true })];
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.getByTestId('gym-manage-gym-1').getAttribute('href')).toBe('/gym/gym-1/manage');
    expect(screen.queryByTestId('gym-view-gym-1')).toBeNull();
  });

  it('renders error state when fetch fails', () => {
    mockError = 'boom';
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.getByTestId('my-gyms-error')).toBeDefined();
    expect(screen.getByText(/couldn't load your gyms/)).toBeDefined();
  });

  it('opens the gym search from the header search icon', () => {
    mockGyms = [makeGym()];
    render(<MyGymsDrawer open onClose={mockOnClose} />);
    expect(screen.queryByTestId('gym-search')).toBeNull();

    fireEvent.click(screen.getByLabelText('Find your gym'));

    const search = screen.getByTestId('gym-search');
    expect(search).toBeDefined();
    expect(screen.getByText('Category: gyms')).toBeDefined();
  });

  it('opens the gym search from the empty-state button', () => {
    mockGyms = [];
    render(<MyGymsDrawer open onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId('my-gyms-find'));

    expect(screen.getByTestId('gym-search')).toBeDefined();
  });
});
