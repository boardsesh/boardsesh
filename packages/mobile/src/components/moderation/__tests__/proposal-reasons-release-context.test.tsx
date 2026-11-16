// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { ProposalReasonsList } from '../ProposalReasonsList';

const state = vi.hoisted(() => ({
  comments: [
    {
      uuid: 'first-reason',
      userId: 'proposer',
      userDisplayName: 'Crew member',
      body: 'The holds came off',
      isDeleted: false,
      createdAt: '2026-10-14T09:00:00Z',
    },
  ],
  diagnostics: [
    {
      commentUuid: 'first-reason',
      releaseContext: {
        channel: 'production',
        branch: null,
        updateId: 'canary-update',
        runtimeVersion: 'fingerprint',
        isEmbeddedLaunch: false,
        automaticCanary: true,
        canaryCheckedAt: '2026-10-14T09:00:00Z',
      },
    },
  ],
}));
const diagnosticsQuery = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => 'now' }));
vi.mock('../../../lib/graphql/hooks/use-social', () => ({
  useComments: () => ({ data: { comments: state.comments }, isPending: false, isError: false }),
}));
vi.mock('../../../lib/graphql/hooks/use-proposal-report-release-contexts', () => ({
  useProposalReportReleaseContexts: (proposalUuid: string, enabled: boolean) => {
    diagnosticsQuery(proposalUuid, enabled);
    // A stale response is deliberately returned even after access is revoked.
    return state.diagnostics;
  },
}));
beforeEach(() => diagnosticsQuery.mockClear());

const props = { proposalUuid: 'proposal', proposerId: 'proposer', reason: 'The holds came off', expanded: true };
describe('proposal report release diagnostics', () => {
  it('shows the first reporter release while keeping their repeated reason deduplicated', () => {
    const screen = render(<ProposalReasonsList {...props} canReadReleaseContext />);
    expect(diagnosticsQuery).toHaveBeenLastCalledWith('proposal', true);
    expect(screen.getByText('mobile.reportRelease.title')).toBeTruthy();
    expect(screen.getByText(/canary-update/)).toBeTruthy();
    expect(screen.queryByText('The holds came off')).toBeNull();
    expect(screen.queryByText('mobile.moderation.noReasons')).toBeNull();
  });

  it('hides stale diagnostics immediately when admin access is removed', () => {
    const screen = render(<ProposalReasonsList {...props} canReadReleaseContext />);
    expect(screen.getByText(/canary-update/)).toBeTruthy();
    screen.rerender(<ProposalReasonsList {...props} canReadReleaseContext={false} />);
    expect(diagnosticsQuery).toHaveBeenLastCalledWith('proposal', false);
    expect(screen.queryByText(/canary-update/)).toBeNull();
    expect(screen.queryByText('mobile.reportRelease.title')).toBeNull();
  });

  it('keeps collapsed and nonadmin cards from requesting report diagnostics', () => {
    const screen = render(<ProposalReasonsList {...props} canReadReleaseContext={false} />);
    expect(diagnosticsQuery).toHaveBeenLastCalledWith('proposal', false);
    screen.rerender(<ProposalReasonsList {...props} expanded={false} canReadReleaseContext />);
    expect(diagnosticsQuery).toHaveBeenLastCalledWith('proposal', false);
    expect(screen.queryByText('mobile.reportRelease.title')).toBeNull();
  });
});
