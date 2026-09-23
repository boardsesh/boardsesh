import { Redirect } from 'expo-router';
import { getAppEntryHref } from '../src/lib/app-entry-route';

/**
 * App launcher route. Opens the last-selected board's library in Climbs.
 * Explicit tab routes (join -> Record, deep links) keep their own target.
 */
export default function MobileHome() {
  return <Redirect href={getAppEntryHref()} />;
}
