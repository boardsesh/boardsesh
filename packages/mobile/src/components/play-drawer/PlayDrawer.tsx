import { PlayCore, type PlayDrawerProps } from './PlayCore';

export { SHARED_BROWSE_LATCH_RELEASE_MS, type PlayDrawerOpenOptions, type PlayDrawerOpenTarget } from './PlayCore';

/** Route and persistent pane share one authoritative player core. */
export function PlayDrawer(props: PlayDrawerProps) {
  return <PlayCore {...props} />;
}
