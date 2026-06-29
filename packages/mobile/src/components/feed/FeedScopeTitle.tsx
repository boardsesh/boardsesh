// The Home feed's scope control. It shows the active scope ("My crew" / a gym name /
// "Everyone") with a down-caret and opens a dropdown to switch scope / pick a gym.
//
// The anchor + menu are now the native, OS-split `AppMenu` (a SwiftUI glass Menu
// button on iOS, a Compose DropdownMenu on Android), so this component just feeds it
// the scope label and a per-variant width cap. The two parents position it: the glass
// floating chrome centres the slot (`headerCenter`), the Material app bar lays it
// leading. The only thing left to vary is how wide the title-menu may grow before it
// crowds the trailing find-climbers action.

import { AppMenu, type AppMenuAction } from '../AppMenu';
import { useVariantValue } from '../../theme/variants';

type FeedScopeTitleProps = {
  /** The active scope, shown in the title-menu. */
  title: string;
  /** Menu items, in render order; `onSelectIndex` is called with the tapped index. */
  actions: AppMenuAction[];
  onSelectIndex: (index: number) => void;
  /** VoiceOver hint — the control is a menu, so cue what activating it does. */
  accessibilityHint?: string;
};

export function FeedScopeTitle({ title, actions, onSelectIndex, accessibilityHint }: FeedScopeTitleProps) {
  // The glass pill floats with more room to grow; the Material app-bar title shares
  // its row with the avatar + find-climbers action, so it stays a touch tighter.
  const maxWidth = useVariantValue({ liquidGlass: 240, material: 220 });

  return (
    <AppMenu
      label={title}
      actions={actions}
      onSelectIndex={onSelectIndex}
      maxWidth={maxWidth}
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
    />
  );
}
