import { Redirect } from 'expo-router';
import { getAppEntryHref } from '../src/lib/app-entry-route';

/**
 * App launcher route. Opens the tab the climber chose to start on (Climbs, on
 * the last-selected board, unless they picked Home in Settings › General).
 * Explicit tab routes (join -> Record, deep links) keep their own target.
 */
export default function MobileHome() {
  return <Redirect href={getAppEntryHref()} />;
}
