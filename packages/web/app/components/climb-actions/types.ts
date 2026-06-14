import type { Climb, BoardDetails } from '@/app/lib/types';

/**
 * Available action types for climbs
 */
export type ClimbActionType =
  | 'viewDetails'
  | 'fork'
  | 'favorite'
  | 'setActive'
  | 'queue'
  | 'goToQueue'
  | 'tick'
  | 'openInApp'
  | 'mirror'
  | 'share'
  | 'addBetaVideo'
  | 'playlist';

/**
 * View modes for rendering climb actions
 * - icon: Icon-only display (for Card actions)
 * - button: Full buttons with labels
 * - dropdown: Menu items for Dropdown component
 * - compact: Small buttons with labels on hover
 */
export type ClimbActionsViewMode = 'icon' | 'button' | 'dropdown' | 'compact' | 'list';

/**
 * Size options for action buttons/icons
 */
export type ClimbActionSize = 'small' | 'default' | 'large';

/**
 * Base props required for all action components
 */
export type ClimbActionBaseProps = {
  climb: Climb;
  boardDetails: BoardDetails;
  angle: number;
  /** Current route pathname for context-aware URL construction (e.g. preserving /b/{slug}/{angle}). */
  currentPathname?: string;
};

/**
 * Props for individual action components
 */
export type ClimbActionProps = {
  viewMode: ClimbActionsViewMode;
  size?: ClimbActionSize;
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
  onComplete?: () => void;
  onOpenPlaylistSelector?: () => void;
  /** When provided, the tick action calls this instead of its built-in drawer flow. */
  onTickAction?: () => void;
  /** When provided, the goToQueue action calls this to open the queue list. */
  onGoToQueue?: () => void;
} & ClimbActionBaseProps;

/**
 * Props for the high-level ClimbActions component
 */
export type ClimbActionsProps = {
  /** View mode for rendering actions */
  viewMode: ClimbActionsViewMode;
  /** Show only these actions (if not provided, shows all available) */
  include?: ClimbActionType[];
  /** Hide these actions */
  exclude?: ClimbActionType[];
  /** Size of buttons/icons */
  size?: ClimbActionSize;
  /** Additional CSS class */
  className?: string;
  /** Callback when any action is performed */
  onActionComplete?: (action: ClimbActionType) => void;
  /** Callback to transition into a dedicated playlist selector UI */
  onOpenPlaylistSelector?: () => void;
  /** Aurora app URL for Open in App action */
  auroraAppUrl?: string;
  /** When provided, the tick action calls this instead of its built-in drawer flow. */
  onTickAction?: () => void;
  /** When provided, the goToQueue action calls this to open the queue list. */
  onGoToQueue?: () => void;
} & ClimbActionBaseProps;

/**
 * Menu item type for dropdown mode
 */
export type ClimbActionMenuItem = {
  key?: React.Key;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
};

/**
 * Result from individual action components for different render modes
 */
export type ClimbActionResult = {
  /** The rendered element (for icon/button modes) */
  element: React.ReactNode;
  /** Menu item config (for dropdown mode) */
  menuItem: ClimbActionMenuItem;
  /** Unique key for React lists */
  key: ClimbActionType;
  /** Whether the action is currently available */
  available: boolean;
  /** Optional expanded content to render inline (e.g., playlist selector) */
  expandedContent?: React.ReactNode;
};

/**
 * Return type for useClimbActions hook
 */
export type UseClimbActionsReturn = {
  // Action handlers
  handleViewDetails: () => void;
  handleFork: () => void;
  handleFavorite: () => Promise<void>;
  handleQueue: () => void;
  handleTick: () => void;
  handleOpenInApp: () => void;
  handleMirror: () => void;
  handleShare: () => Promise<void>;
  // State
  isFavorited: boolean;
  isFavoriteLoading: boolean;
  isAuthenticated: boolean;
  recentlyAddedToQueue: boolean;
  // Computed availability
  canFork: boolean;
  canMirror: boolean;

  // URLs
  viewDetailsUrl: string;
  forkUrl: string | null;
  openInAppUrl: string | null;
};

/**
 * Default order of actions when displayed
 */
export const DEFAULT_ACTION_ORDER: ClimbActionType[] = [
  'mirror',
  'setActive',
  'queue',
  'goToQueue',
  'share',
  'favorite',
  'tick',
  'playlist',
  'fork',
  'viewDetails',
  'openInApp',
];

/**
 * Full climb action sheet order. Includes larger workflow actions that do
 * not belong on compact card/icon surfaces.
 */
export const ACTION_SHEET_ACTION_ORDER: ClimbActionType[] = [
  'mirror',
  'setActive',
  'queue',
  'goToQueue',
  'share',
  'addBetaVideo',
  'favorite',
  'tick',
  'playlist',
  'fork',
  'viewDetails',
  'openInApp',
];

/**
 * Actions that require authentication
 */
export const AUTH_REQUIRED_ACTIONS: ClimbActionType[] = ['favorite', 'playlist', 'addBetaVideo'];

/**
 * Actions that require Aurora credentials
 */
export const AURORA_CREDENTIALS_REQUIRED_ACTIONS: ClimbActionType[] = ['tick'];
