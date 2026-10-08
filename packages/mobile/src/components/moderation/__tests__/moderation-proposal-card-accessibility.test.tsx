// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Proposal } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/profile-stats', () => ({ getLayoutDisplayName: () => 'Layout' }));
vi.mock('@boardsesh/community-roles', () => ({ rolesGrantAdminOrLeader: () => false }));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../Card', () => ({ Card: ({ children }: Children) => createElement('div', null, children) }));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../Button', () => ({ Button: () => null }));
vi.mock('../../ClimbListThumbnail', () => ({ ClimbListThumbnail: () => null }));
vi.mock('../ProposalReasonsList', () => ({ ProposalReasonsList: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onLongPress,
    accessibilityActions,
    onAccessibilityAction,
  }: Children & {
    onLongPress?: () => void;
    accessibilityActions?: { name: string; label: string }[];
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }) =>
    createElement(
      'div',
      {
        'data-testid': 'climb-block',
        'data-action-label': accessibilityActions?.map((action) => action.label).join('|'),
        // jsdom has no long press: contextmenu is the gesture, doubleclick the screen-reader action.
        onContextMenu: onLongPress,
        onDoubleClick: () =>
          onAccessibilityAction?.({ nativeEvent: { actionName: accessibilityActions?.[0]?.name ?? '' } }),
      },
      children,
    ),
}));
vi.mock('../proposal-presenters', () => ({
  extraReasonCount: () => 0,
  proposalToClimb: () => null,
  isUnhideProposal: () => false,
  proposalTypeLine: () => ({ textI18nKey: 'climbs:type', params: {} }),
  statusChip: () => null,
  voteProgress: () => ({ current: 0, required: 3, reporters: 1, opposed: 0 }),
}));
vi.mock('../../../lib/graphql/hooks/use-vote-on-proposal', () => ({
  useVoteOnProposal: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../lib/graphql/hooks/use-resolve-proposal', () => ({
  useResolveProposal: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: () => null }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: () => {}, hapticMedium: () => {} }));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => 'now' }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { separator: '#ccc', secondaryLabel: '#666', tertiaryLabel: '#999', label: '#000', fill: '#eee' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: () => {} }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ formatGrade: () => null }) }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8, full: 999 },
}));

import { ModerationProposalCard } from '../ModerationProposalCard';

const proposal = {
  uuid: 'p1',
  status: 'resolved',
  boardType: 'kilter',
  layoutId: 1,
  climbName: 'Test Climb',
  climbDifficulty: null,
  frames: null,
  proposerId: 'u1',
  proposerDisplayName: 'Ada',
  createdAt: '2026-06-15T10:00:00.000Z',
} as unknown as Proposal;

const onLongPressClimb = vi.fn();

beforeEach(() => onLongPressClimb.mockClear());

describe('ModerationProposalCard — screen-reader route to the long-press menu', () => {
  it('publishes a custom action that calls the same handler as a long press', () => {
    const { getByTestId } = render(
      <ModerationProposalCard
        proposal={proposal}
        roles={[]}
        isSignedIn
        onOpenClimb={vi.fn()}
        onLongPressClimb={onLongPressClimb}
      />,
    );
    const block = getByTestId('climb-block');
    expect(block.getAttribute('data-action-label')).toBe('mobile.climbRow.moreActions');

    fireEvent.contextMenu(block);
    expect(onLongPressClimb).toHaveBeenCalledWith(proposal);
    onLongPressClimb.mockClear();

    fireEvent.doubleClick(block);
    expect(onLongPressClimb).toHaveBeenCalledWith(proposal);
  });
});
