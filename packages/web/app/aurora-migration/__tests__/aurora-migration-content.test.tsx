import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import AuroraMigrationContent from '../aurora-migration-content';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

let mockSessionStatus = 'unauthenticated';
let mockSessionData: { user?: { email?: string } } | null = null;

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSessionData, status: mockSessionStatus }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/aurora-migration',
}));

const mockOpenAuthModal = vi.fn();
vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: mockOpenAuthModal }),
}));

vi.mock('@/app/components/board-entity/board-import-prompt', () => ({
  default: ({ boardType }: { boardType: string }) => (
    <div data-testid={`board-import-prompt-${boardType}`}>Import {boardType}</div>
  ),
}));

describe('AuroraMigrationContent', () => {
  beforeEach(() => {
    mockSessionStatus = 'unauthenticated';
    mockSessionData = null;
    mockOpenAuthModal.mockClear();
  });

  it('renders the "What Happened" section', () => {
    render(<AuroraMigrationContent />);
    expect(screen.getByText('What Happened')).toBeTruthy();
    expect(screen.getByText(/The Aurora Kilter backend is gone/)).toBeTruthy();
  });

  it('renders the "How to Migrate" section with 3 steps', () => {
    render(<AuroraMigrationContent />);
    expect(screen.getByText('How to Migrate')).toBeTruthy();
    expect(screen.getByText('Request your data export')).toBeTruthy();
    expect(screen.getByText('Create a Boardsesh account')).toBeTruthy();
    expect(screen.getByText('Import your data')).toBeTruthy();
  });

  it('renders the email link for data export request', () => {
    render(<AuroraMigrationContent />);
    const emailButton = screen.getByText('Email peter@auroraclimbing.com');
    expect(emailButton.closest('a')).toBeTruthy();
    expect(emailButton.closest('a')?.getAttribute('href')).toContain('mailto:peter@auroraclimbing.com');
  });

  it('renders the "Get Help" section with Discord and GitHub links', () => {
    render(<AuroraMigrationContent />);
    expect(screen.getByText('Get Help')).toBeTruthy();
    expect(screen.getByText(/Discord/)).toBeTruthy();
    expect(screen.getByText(/GitHub/)).toBeTruthy();
  });

  describe('when unauthenticated', () => {
    it('shows sign in button instead of import prompts', () => {
      render(<AuroraMigrationContent />);
      expect(screen.getByText('Sign in or Create Account')).toBeTruthy();
      expect(screen.getByText('Sign in first to import your data.')).toBeTruthy();
      expect(screen.queryByTestId('board-import-prompt-kilter')).toBeNull();
      expect(screen.queryByTestId('board-import-prompt-tension')).toBeNull();
    });

    it('opens auth modal when sign in button is clicked', () => {
      render(<AuroraMigrationContent />);

      fireEvent.click(screen.getByText('Sign in or Create Account'));
      expect(mockOpenAuthModal).toHaveBeenCalledTimes(1);
      expect(mockOpenAuthModal).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Sign in to migrate your data' }),
      );
    });

    it('calls openAuthModal each time sign in button is clicked', () => {
      render(<AuroraMigrationContent />);
      fireEvent.click(screen.getByText('Sign in or Create Account'));
      expect(mockOpenAuthModal).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByText('Sign in or Create Account'));
      expect(mockOpenAuthModal).toHaveBeenCalledTimes(2);
    });
  });

  describe('when authenticated', () => {
    beforeEach(() => {
      mockSessionStatus = 'authenticated';
      mockSessionData = { user: { email: 'test@example.com' } };
    });

    it('shows signed in confirmation', () => {
      render(<AuroraMigrationContent />);
      expect(screen.getByText(/Signed in as test@example.com/)).toBeTruthy();
      expect(screen.queryByText('Sign in or Create Account')).toBeNull();
    });

    it('renders board import prompts for kilter and tension', () => {
      render(<AuroraMigrationContent />);
      expect(screen.getByTestId('board-import-prompt-kilter')).toBeTruthy();
      expect(screen.getByTestId('board-import-prompt-tension')).toBeTruthy();
    });

    it('does not show "sign in first" message', () => {
      render(<AuroraMigrationContent />);
      expect(screen.queryByText('Sign in first to import your data.')).toBeNull();
    });
  });
});
