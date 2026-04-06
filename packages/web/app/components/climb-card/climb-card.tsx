'use client';

import React from 'react';
import MuiCard from '@mui/material/Card';
import CardHeader from '@mui/material/CardHeader';
import CardContent from '@mui/material/CardContent';
import CardActions from '@mui/material/CardActions';
import { usePathname } from 'next/navigation';

import ClimbCardCover from './climb-card-cover';
import ClimbTitle from './climb-title';
import HeartAnimationOverlay from './heart-animation-overlay';
import { Climb, BoardDetails } from '@/app/lib/types';
import { ClimbActions } from '../climb-actions';
import { useDoubleTapFavorite } from '../climb-actions/use-double-tap-favorite';
import { themeTokens } from '@/app/theme/theme-config';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import { useIsClimbSelected } from '../board-page/selected-climb-store';

type ClimbCardProps = {
  climb?: Climb;
  boardDetails: BoardDetails;
  coverLinkToClimb?: boolean;
  onCoverClick?: () => void;
  onCoverDoubleClick?: () => void;
  preferImageLayers?: boolean;
  /** When true, the card is visually dimmed (greyed out) but still interactive */
  unsupported?: boolean;
  actions?: React.JSX.Element[];
  /** Optional expanded content to render over the cover */
  expandedContent?: React.ReactNode;
};

/**
 * Compare actions arrays for memo equality.
 * Handles common cases: both undefined, both empty arrays, or same reference.
 */
const areActionsEqual = (prev: React.JSX.Element[] | undefined, next: React.JSX.Element[] | undefined): boolean => {
  // Same reference (including both undefined)
  if (prev === next) return true;
  // One undefined, one not
  if (!prev || !next) return false;
  // Both empty arrays (common case: actions={[]} passed each render)
  if (prev.length === 0 && next.length === 0) return true;
  // Different lengths
  if (prev.length !== next.length) return false;
  // Compare by keys (React elements should have stable keys)
  return prev.every((el, i) => el.key === next[i].key);
};

/**
 * Inner component that handles dynamic action generation.
 * Separated to allow proper hook usage without affecting memoization of static cases.
 * Note: This component generates its own actions - external props are not supported.
 *
 * Uses ClimbActions component directly to ensure hooks are called within the React component tree.
 */
function ClimbCardWithActions({
  climb,
  boardDetails,
  onCoverClick,
  onCoverDoubleClick,
  preferImageLayers,
  unsupported,
}: {
  climb: Climb;
  boardDetails: BoardDetails;
  onCoverClick?: () => void;
  onCoverDoubleClick?: () => void;
  preferImageLayers?: boolean;
  unsupported?: boolean;
}) {
  const pathname = usePathname();
  const { mode } = useColorMode();
  const isDark = mode === 'dark';
  const selected = useIsClimbSelected(climb.uuid);

  const {
    handleDoubleTap,
    showHeart,
    dismissHeart,
  } = useDoubleTapFavorite({ climbUuid: climb.uuid });

  const cover = (
    <ClimbCardCover
      climb={climb}
      boardDetails={boardDetails}
      onClick={onCoverClick}
      onDoubleClick={onCoverDoubleClick ?? handleDoubleTap}
      preferImageLayers={preferImageLayers}
    />
  );
  const cardTitle = <ClimbTitle climb={climb} layout="horizontal" showSetterInfo />;

  const excludeActions = getExcludedClimbActions(boardDetails.board_name, 'card');

  return (
    <div data-testid="climb-card" style={unsupported ? { opacity: 0.5, filter: 'grayscale(80%)' } : undefined}>
      <MuiCard>
        <CardHeader
          title={cardTitle}
          sx={{ paddingTop: `${themeTokens.spacing[2]}px`, paddingBottom: `${themeTokens.spacing[1] + 2}px` }}
        />
        <CardContent
          sx={{
            padding: `${themeTokens.spacing[1] + 2}px`,
            backgroundColor: selected
              ? (getGradeTintColor(climb.difficulty, 'light', isDark) ?? 'var(--semantic-selected-light)')
              : undefined,
          }}
        >
          <div style={{ position: 'relative' }}>
            {cover}
            <HeartAnimationOverlay visible={showHeart} onAnimationEnd={dismissHeart} />
          </div>
        </CardContent>
        {/* Actions rendered as a proper component to support hooks */}
        <CardActions
          sx={{
            justifyContent: 'space-around',
            borderTop: `1px solid var(--neutral-200)`,
          }}
        >
          <ClimbActions
            climb={climb}
            boardDetails={boardDetails}
            angle={climb.angle}
            currentPathname={pathname}
            viewMode="icon"
            exclude={excludeActions}
          />
        </CardActions>
      </MuiCard>
    </div>
  );
}

/**
 * Memoized component for when actions are provided externally.
 */
const ClimbCardStatic = React.memo(
  ({
    climb,
    boardDetails,
    onCoverClick,
    onCoverDoubleClick,
    preferImageLayers,
    actions,
    expandedContent,
  }: ClimbCardProps) => {
    const { mode } = useColorMode();
    const isDark = mode === 'dark';
    const selected = useIsClimbSelected(climb?.uuid ?? '');
    const cover = (
      <ClimbCardCover
        climb={climb}
        boardDetails={boardDetails}
        onClick={onCoverClick}
        onDoubleClick={onCoverDoubleClick}
        preferImageLayers={preferImageLayers}
      />
    );
    const cardTitle = climb ? <ClimbTitle climb={climb} layout="horizontal" showSetterInfo /> : 'Loading...';

    return (
      <div data-testid="climb-card">
        <MuiCard>
          <CardHeader
            title={cardTitle}
            sx={{ paddingTop: `${themeTokens.spacing[2]}px`, paddingBottom: `${themeTokens.spacing[1] + 2}px` }}
          />
          <CardContent
            sx={{
              padding: `${themeTokens.spacing[1] + 2}px`,
              backgroundColor: selected
                ? (getGradeTintColor(climb?.difficulty, 'light', isDark) ?? 'var(--semantic-selected-light)')
                : undefined,
            }}
          >
            <div style={{ position: 'relative' }}>
              {cover}
              {expandedContent}
            </div>
          </CardContent>
          {actions && actions.length > 0 && (
            <CardActions sx={{ justifyContent: 'space-around', borderTop: `1px solid var(--neutral-200)` }}>
              {actions}
            </CardActions>
          )}
        </MuiCard>
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Compare climb by uuid (stable identifier)
    if (prevProps.climb?.uuid !== nextProps.climb?.uuid) return false;
    // Compare boardDetails by reference (stable from server) or by key identifiers
    if (prevProps.boardDetails !== nextProps.boardDetails) {
      // Fallback: compare by stable identifiers if references differ
      const prevBd = prevProps.boardDetails;
      const nextBd = nextProps.boardDetails;
      if (
        prevBd.board_name !== nextBd.board_name ||
        prevBd.layout_id !== nextBd.layout_id ||
        prevBd.size_id !== nextBd.size_id
      ) {
        return false;
      }
    }
    // Compare callbacks by reference (parent should memoize with useCallback)
    if (prevProps.onCoverClick !== nextProps.onCoverClick) return false;
    if (prevProps.onCoverDoubleClick !== nextProps.onCoverDoubleClick) return false;
    if (prevProps.preferImageLayers !== nextProps.preferImageLayers) return false;
    // Compare actions arrays properly
    if (!areActionsEqual(prevProps.actions, nextProps.actions)) return false;
    // Compare expandedContent by reference
    if (prevProps.expandedContent !== nextProps.expandedContent) return false;

    return true;
  },
);

ClimbCardStatic.displayName = 'ClimbCardStatic';

/**
 * ClimbCard component that displays a climb in a card format.
 *
 * Behavior:
 * - When `actions` or `expandedContent` props are provided, uses memoized static component
 * - When neither is provided and climb exists, generates actions dynamically (allows action state like playlist selector)
 * - When no climb, shows loading state
 */
function ClimbCard(props: ClimbCardProps) {
  const { climb, boardDetails, onCoverClick, onCoverDoubleClick, unsupported, actions, expandedContent } =
    props;
  const { preferImageLayers } = props;

  // When actions or expandedContent are provided externally, use the memoized static version
  if (actions !== undefined || expandedContent !== undefined) {
    return (
      <ClimbCardStatic
        climb={climb}
        boardDetails={boardDetails}
        onCoverClick={onCoverClick}
        onCoverDoubleClick={onCoverDoubleClick}
        preferImageLayers={preferImageLayers}
        actions={actions}
        expandedContent={expandedContent}
      />
    );
  }

  // When no actions/expandedContent provided and we have a climb, generate actions dynamically
  // This path is not memoized because action components contain internal state
  if (climb) {
    return (
      <ClimbCardWithActions
        climb={climb}
        boardDetails={boardDetails}
        onCoverClick={onCoverClick}
        onCoverDoubleClick={onCoverDoubleClick}
        preferImageLayers={preferImageLayers}
        unsupported={unsupported}
      />
    );
  }

  // Loading state
  return (
    <ClimbCardStatic
      climb={climb}
      boardDetails={boardDetails}
      onCoverClick={onCoverClick}
      onCoverDoubleClick={onCoverDoubleClick}
      preferImageLayers={preferImageLayers}
      actions={[]}
    />
  );
}

export default ClimbCard;
