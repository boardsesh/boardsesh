// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { GymPageActions } from '../GymPageSections';

type Children = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { gym?: string }) => (options?.gym ? `${key}:${options.gym}` : key),
  }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#666', label: '#000', separator: '#ccc' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 } }));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => '' }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
vi.mock('../../Card', () => ({ Card: ({ children }: Children) => createElement('div', null, children) }));
vi.mock('../../EmptyState', () => ({ EmptyState: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../InsetGroupedList', () => ({ InsetGroupedList: () => null, insetGroupedRowStyles: {} }));
vi.mock('../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../../ShelfHeader', () => ({
  SHELF_SECTION_GAP: 24,
  SHELF_HEADER_CONTENT_GAP: 8,
  ShelfHeader: () => null,
  ShelfSection: ({ children }: Children) => createElement('div', null, children),
}));
vi.mock('../../StatusPill', () => ({ StatusPill: () => null }));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../TextAction', () => ({ TextAction: () => null }));

import { GymClaimCardBlock } from '../GymPageSections';

const actions: GymPageActions = {
  onOpenAddress: vi.fn(),
  onClaim: vi.fn(),
  onSignIn: vi.fn(),
  onStartRow: vi.fn(),
  onStaffTool: vi.fn(),
  onInfoRow: vi.fn(),
  onSetUpBoard: vi.fn(),
  onRetryBoards: vi.fn(),
  onReport: vi.fn(),
};

afterEach(cleanup);

describe('GymClaimCardBlock: a claim that did not go through', () => {
  it('offers Try again, in the copy and as a button, while the gym can still be claimed', () => {
    render(<GymClaimCardBlock card="denied" gymName="Crux" actions={actions} />);
    expect(screen.getByText('mobile.gymPage.claimDenied:Crux')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'mobile.gymPage.claimRetry' })).toBeTruthy();
  });

  it('drops Try again from both once the gym cannot be claimed', () => {
    render(<GymClaimCardBlock card="deniedClosed" gymName="Crux" actions={actions} />);
    expect(screen.getByText('mobile.gymPage.claimDeniedClosed:Crux')).toBeTruthy();
    expect(screen.queryByText('mobile.gymPage.claimDenied:Crux')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
