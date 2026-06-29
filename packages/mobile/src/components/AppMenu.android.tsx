// AppMenu — Android implementation, a native Jetpack Compose DropdownMenu via
// @expo/ui/jetpack-compose. Replaces the react-native-paper `Menu` (a JS M3
// re-creation) with the real Compose dropdown — M3 ripple, elevation, open/close
// motion for free. The anchor is a flat `Text` + caret trigger (the M3 app-bar
// title-menu); the active row shows a leading ✓ (no SF Symbols on Android) and
// destructive rows take the `m3.error` text colour. Controlled `expanded` state,
// closed on each select.

import { useState } from 'react';
import { Host } from '@expo/ui';
import { DropdownMenu, DropdownMenuItem, Row, Text } from '@expo/ui/jetpack-compose';
import { clickable, padding, alpha } from '@expo/ui/jetpack-compose/modifiers';
import { useTheme } from '../providers/theme-provider';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { resolveMenuActions } from './AppMenu.logic';
import type { AppMenuProps } from './AppMenu.types';

// Down-caret glyph: the Compose `Icon` needs a vector-drawable source and @expo/ui
// bundles none for a chevron, so a muted glyph stands in (mirrors MoreForm's `›`).
const CARET = '▾';

export function AppMenu({ label, actions, onSelectIndex, showCaret = true, maxWidth, style }: AppMenuProps) {
  const { brandColors, m3 } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const resolved = resolveMenuActions(actions);

  return (
    // `matchContents` (content width AND height): the title-menu hugs its label so it
    // sits leading in the app bar (the find-climbers action is held trailing by a flex
    // spacer). `maxWidth` keeps a long gym name from crowding that action.
    <Host matchContents style={[maxWidth != null ? { maxWidth } : null, style]}>
      <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
        <DropdownMenu.Trigger>
          <Row
            modifiers={[clickable(() => setExpanded(true)), padding(spacing[2], spacing[1], spacing[2], spacing[1])]}
            verticalAlignment="center"
          >
            <Text style={{ typography: 'titleMedium' }} maxLines={1} overflow="ellipsis">
              {label}
            </Text>
            {showCaret ? (
              <Text style={{ typography: 'titleMedium' }} modifiers={[alpha(0.6)]}>
                {` ${CARET}`}
              </Text>
            ) : null}
          </Row>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {resolved.map((action, index) => (
            <DropdownMenuItem
              // Composite key: scope entries can share a display name (two gyms named
              // the same), so the label alone isn't unique — pair it with the position.
              key={`${index}-${action.label}`}
              elementColors={action.isDestructive ? { textColor: m3.error } : undefined}
              onClick={() => {
                setExpanded(false);
                onSelectIndex(index);
              }}
            >
              {action.showCheck ? (
                <DropdownMenuItem.LeadingIcon>
                  <Text color={brandAccentColor(brandColors)}>✓</Text>
                </DropdownMenuItem.LeadingIcon>
              ) : null}
              <DropdownMenuItem.Text>
                <Text>{action.label}</Text>
              </DropdownMenuItem.Text>
            </DropdownMenuItem>
          ))}
        </DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  );
}
