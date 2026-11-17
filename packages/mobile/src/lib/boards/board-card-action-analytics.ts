import { SHARED_EVENTS } from '@boardsesh/analytics';
import type {
  BoardCardMenuAction,
  BoardCardMenuSection,
  BoardCardMenuVia,
} from '../../components/board-discovery/board-card-menu';
import { track } from '../analytics';

export type BoardCardActionEvent = {
  action: BoardCardMenuAction;
  via: BoardCardMenuVia;
  section: BoardCardMenuSection;
};

/** `Board Card Action`: one row picked from a board card's menu. See SHARED_EVENTS. */
export function trackBoardCardAction({ action, via, section }: BoardCardActionEvent): void {
  track(SHARED_EVENTS.BoardCardAction, { action, via, section });
}
