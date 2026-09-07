// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  credentials: undefined as { boardType: string }[] | undefined,
  activeBoard: undefined as { boardType: string } | undefined,
  seenTip: vi.fn(() => Promise.resolve(false)),
  markTipSeen: vi.fn(() => Promise.resolve()),
  credentialsEnabled: undefined as boolean | undefined,
}));

vi.mock('expo-router', () => ({ router: { push: mocks.push } }));

vi.mock('../../../lib/integrations/use-board-account-credentials', () => ({
  useBoardAccountCredentials: (enabled?: boolean) => {
    mocks.credentialsEnabled = enabled;
    return { data: mocks.credentials };
  },
}));

vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: mocks.activeBoard }),
}));

vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenTip: mocks.seenTip,
  markTipSeen: mocks.markTipSeen,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { boardName?: string }) => (opts?.boardName != null ? `${key}:${opts.boardName}` : key),
  }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 4: 16 },
  borderRadius: { lg: 12 },
}));

type RNProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: RNProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('../../Text', () => ({ Text: ({ children }: RNProps) => createElement('span', {}, children) }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', {}) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { 'data-button': title, onClick: onPress }),
}));

import { BoardLinkPrompt } from '../BoardLinkPrompt';

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

describe('BoardLinkPrompt', () => {
  beforeEach(() => {
    mocks.push.mockReset();
    mocks.markTipSeen.mockReset().mockResolvedValue(undefined);
    mocks.seenTip.mockReset().mockResolvedValue(false);
    mocks.credentials = [];
    mocks.activeBoard = { boardType: 'tension' };
    mocks.credentialsEnabled = undefined;
  });

  it('offers to link the board the climber is actually on', async () => {
    const { container } = render(<BoardLinkPrompt viewerIsOwner hasNoSends />);
    await waitFor(() => expect(button(container, 'mobile.boardLink.cta:Tension')).not.toBeNull());
    expect(container.textContent).toContain('mobile.boardLink.title:Tension');
  });

  // The bug this guards: ProgressTab renders on users/[userId] for other climbers.
  // Without the ownership gate, a stranger's empty stats would tell YOU to link
  // YOUR account.
  it('never renders on another climber’s profile', async () => {
    const { container } = render(<BoardLinkPrompt viewerIsOwner={false} hasNoSends />);
    await waitFor(() => expect(mocks.seenTip).not.toHaveBeenCalled());
    expect(container.textContent).toBe('');
    // And it must not even ask the server about the viewer's own accounts.
    expect(mocks.credentialsEnabled).toBe(false);
  });

  it('stays hidden once the climber has sends', async () => {
    const { container } = render(<BoardLinkPrompt viewerIsOwner hasNoSends={false} />);
    await waitFor(() => expect(mocks.credentialsEnabled).toBe(false));
    expect(container.textContent).toBe('');
  });

  it('stays hidden for a climber who already linked an account', async () => {
    mocks.credentials = [{ boardType: 'tension' }];
    const { container } = render(<BoardLinkPrompt viewerIsOwner hasNoSends />);
    await waitFor(() => expect(mocks.seenTip).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  // React Query is offlineFirst here, so an offline launch leaves the credentials
  // query pending forever. Reading that as "nothing linked" would show the card to
  // someone who linked months ago.
  it('renders nothing while the credential read is unresolved', async () => {
    mocks.credentials = undefined;
    const { container } = render(<BoardLinkPrompt viewerIsOwner hasNoSends />);
    await waitFor(() => expect(mocks.seenTip).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('offers the import path for MoonBoard, which cannot be linked at all', async () => {
    mocks.activeBoard = { boardType: 'moonboard' };
    const { container } = render(<BoardLinkPrompt viewerIsOwner hasNoSends />);
    await waitFor(() => expect(button(container, 'mobile.boardLink.moonboardCta')).not.toBeNull());
    expect(button(container, 'mobile.boardLink.cta:MoonBoard')).toBeNull();
  });

  it('falls back to generic copy when no board is bound yet', async () => {
    mocks.activeBoard = undefined;
    const { container } = render(<BoardLinkPrompt viewerIsOwner hasNoSends />);
    await waitFor(() => expect(button(container, 'mobile.boardLink.ctaGeneric')).not.toBeNull());
  });

  it('sends the climber to Connected apps — the screen they could not find', async () => {
    const { container } = render(<BoardLinkPrompt viewerIsOwner hasNoSends />);
    await waitFor(() => expect(button(container, 'mobile.boardLink.cta:Tension')).not.toBeNull());
    button(container, 'mobile.boardLink.cta:Tension')!.click();
    expect(mocks.push).toHaveBeenCalledWith('/(tabs)/profile/integrations');
  });

  it('stays dismissed once dismissed', async () => {
    mocks.seenTip.mockResolvedValue(true);
    const { container } = render(<BoardLinkPrompt viewerIsOwner hasNoSends />);
    await waitFor(() => expect(mocks.seenTip).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
