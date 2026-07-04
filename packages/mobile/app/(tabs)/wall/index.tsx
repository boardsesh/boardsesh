import { WallScreen } from '../../../src/components/board-presence/WallScreen';

/**
 * The "On the Wall" tab screen: what's lit on the board right now, plus the
 * session stats, leaderboard, and history. iPad-only (routed from the sidebar);
 * the layout adapts to portrait (single column) and landscape (focal + list).
 */
export default function WallIndex() {
  return <WallScreen />;
}
