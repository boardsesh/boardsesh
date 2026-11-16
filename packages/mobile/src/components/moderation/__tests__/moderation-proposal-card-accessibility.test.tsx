// @vitest-environment jsdom
vi.mock('../../climb-actions/ClimbActionsPressable', () => import('../../../../test/climb-menu-stub'));
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Proposal } from '@boardsesh/shared-schema';
import type { ClimbActionsTarget } from '../../../providers/drawer-host-provider';
import { climbMenuTestState } from '../../../../test/climb-menu-stub';

type Children = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/profile-stats', () => ({ getLayoutDisplayName: () => 'Layout' }));
vi.mock('@boardsesh/community-roles', () => ({ rolesGrantAdmin: () => false, rolesGrantAdminOrLeader: () => false }));
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
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { separator: '#ccc', secondaryLabel: '#666', tertiaryLabel: '#999', label: '#000', fill: '#eee' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: () => {} }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ formatGrade: () => null }) }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
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

const target = {
  climb: { uuid: 'climb-1', name: 'Test Climb' },
  boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
} as ClimbActionsTarget;
const onLongPressClimb = vi.fn(() => target);

beforeEach(() => {
  onLongPressClimb.mockClear();
  climbMenuTestState.commands = [];
  climbMenuTestState.openedRows = null;
});

describe('ModerationProposalCard — native climb commands', () => {
  it('shares the pinned proposal target between native long press and screen-reader commands', () => {
    const onOpenClimb = vi.fn();
    const { container } = render(
      <ModerationProposalCard
        proposal={proposal}
        roles={[]}
        isSignedIn
        onOpenClimb={onOpenClimb}
        onLongPressClimb={onLongPressClimb}
      />,
    );
    const block = container.querySelector('[data-climb-actions-body]')!;
    expect(onLongPressClimb).toHaveBeenCalledExactlyOnceWith(proposal);
    expect(block.getAttribute('data-action-label')).toBe('Share');

    fireEvent.contextMenu(block);
    expect(climbMenuTestState.openedRows?.map((action) => action.id)).toEqual(['share']);
    expect(climbMenuTestState.commands).toEqual([]);

    fireEvent.doubleClick(block);
    expect(climbMenuTestState.commands).toEqual([{ id: 'share', target }]);
    expect(onLongPressClimb).toHaveBeenCalledTimes(1);
    expect(onOpenClimb).not.toHaveBeenCalled();
    fireEvent.click(block);
    expect(onOpenClimb).toHaveBeenCalledWith(proposal);
  });

  it('keeps the primary action without advertising commands for an unresolved target', () => {
    const onOpenClimb = vi.fn();
    const { container } = render(
      <ModerationProposalCard
        proposal={proposal}
        roles={[]}
        isSignedIn
        onOpenClimb={onOpenClimb}
        onLongPressClimb={() => null}
      />,
    );
    expect(container.querySelector('[data-native-climb-menu]')).toBeNull();
    const block = container.querySelector('[data-climb-actions-body]')!;
    fireEvent.doubleClick(block);
    expect(climbMenuTestState.commands).toEqual([]);
    fireEvent.click(block);
    expect(onOpenClimb).toHaveBeenCalledWith(proposal);
  });
});
