import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

let mockSessionStatus = 'unauthenticated';
let mockSessionData: { user?: { id?: string; email?: string } } | null = null;

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSessionData, status: mockSessionStatus }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/aurora-migration',
}));

vi.mock('@/app/components/auth/auth-modal', () => ({
  default: ({ open, onClose, title }: { open: boolean; onClose: () => void; title: string }) =>
    open ? (
      <div data-testid="auth-modal">
        <span>{title}</span>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

vi.mock('@/app/components/settings/board-import-prompt', () => ({
  default: ({ boardType }: { boardType: string }) => (
    <div data-testid={`board-import-prompt-${boardType}`}>Import {boardType}</div>
  ),
}));

vi.mock('@/app/components/user-smart-card/user-smart-card', () => ({
  default: ({ userId }: { userId: string }) => (
    <div data-testid="user-smart-card">Smart card for {userId}</div>
  ),
}));

import AuroraMigrationContent from '../aurora-migration-content';

describe('AuroraMigrationContent', () => {
  beforeEach(() => {
    mockSessionStatus = 'unauthenticated';
    mockSessionData = null;
  });

  it('renders the "What Happened" section', () => {
    render(<AuroraMigrationContent />);
    expect(screen.getByText('What Happened')).toBeTruthy();
    expect(screen.getByText(/The Aurora Kilter backend is gone/)).toBeTruthy();
  });

  it('renders the "How to Migrate" section with 4 steps', () => {
    render(<AuroraMigrationContent />);
    expect(screen.getByText('How to Migrate')).toBeTruthy();
    expect(screen.getByText('Request your data export')).toBeTruthy();
    expect(screen.getByText('Create a Boardsesh account')).toBeTruthy();
    expect(screen.getByText('Import your data')).toBeTruthy();
    expect(screen.getByText('Check out your profile')).toBeTruthy();
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
      expect(screen.queryByTestId('auth-modal')).toBeNull();

      fireEvent.click(screen.getByText('Sign in or Create Account'));
      expect(screen.getByTestId('auth-modal')).toBeTruthy();
      expect(screen.getByText('Sign in to migrate your data')).toBeTruthy();
    });

    it('closes auth modal when close is clicked', () => {
      render(<AuroraMigrationContent />);
      fireEvent.click(screen.getByText('Sign in or Create Account'));
      expect(screen.getByTestId('auth-modal')).toBeTruthy();

      fireEvent.click(screen.getByText('Close'));
      expect(screen.queryByTestId('auth-modal')).toBeNull();
    });
  });

  describe('when authenticated', () => {
    beforeEach(() => {
      mockSessionStatus = 'authenticated';
      mockSessionData = { user: { id: 'user-1', email: 'test@example.com' } };
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

    it('renders user smart card in step 4', () => {
      render(<AuroraMigrationContent />);
      expect(screen.getByTestId('user-smart-card')).toBeTruthy();
    });
  });

  describe('step 4 when unauthenticated', () => {
    it('shows sign in prompt instead of smart card', () => {
      render(<AuroraMigrationContent />);
      expect(screen.getByText('Sign in to see a preview of your profile.')).toBeTruthy();
      expect(screen.queryByTestId('user-smart-card')).toBeNull();
    });
  });
});
