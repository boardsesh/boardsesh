import { AppMenu } from '../AppMenu';
import type { MiniPlayerMenuAnchorProps } from './MiniPlayerMenuAnchor.types';

export function MiniPlayerMenuAnchor(props: MiniPlayerMenuAnchorProps) {
  return <AppMenu {...props} />;
}
