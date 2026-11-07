import { StyleSheet } from 'react-native';
import { LazyColumn, Card, Column, Text } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, padding } from '@expo/ui/jetpack-compose/modifiers';
import { ComposeHost } from './ComposeHost.android';
import { renderSettingsRow, useSettingsRowColors } from './settings-rows.android';
import { spacing } from '../theme/tokens';
import type { MoreFormProps } from './MoreForm.types';

const SECTION_GAP = spacing[5];

// Compose RNHostView rows report their height but draw blank on Android
// (#6500, #6585, #6546). Screens whose model has a `custom` row therefore pick
// MoreFormRN themselves, once per screen, so the renderer never swaps mid-flow.
export function MoreForm({ model }: MoreFormProps) {
  const colors = useSettingsRowColors();

  // One LazyColumn item per section: title Text, the rows (carded unless the
  // section is all buttons), then footer Text. The gaps are padding modifiers,
  // not the LazyColumn's `spacedBy`: that arrangement never reached the device,
  // so adjacent section cards rendered flush against each other.
  const items = model.sections.map((section, index) => {
    const allButtons = section.rows.every((row) => row.kind === 'button');
    return (
      <Column key={section.key} modifiers={[fillMaxWidth(), padding(0, index === 0 ? 0 : SECTION_GAP, 0, 0)]}>
        {section.title ? (
          <Text
            style={{ typography: 'titleSmall' }}
            color={colors.sectionTextColor}
            modifiers={[padding(spacing[1], 0, spacing[1], spacing[2])]}
          >
            {section.title}
          </Text>
        ) : null}
        {allButtons ? (
          // Standalone full-width buttons (e.g. Sign Out / Delete Account), no card.
          section.rows.map((row, rowIndex) => (
            <Column key={row.key} modifiers={[fillMaxWidth(), padding(0, rowIndex === 0 ? 0 : spacing[2], 0, 0)]}>
              {renderSettingsRow(row, colors)}
            </Column>
          ))
        ) : (
          <Card modifiers={[fillMaxWidth()]}>
            <Column modifiers={[fillMaxWidth()]}>{section.rows.map((row) => renderSettingsRow(row, colors))}</Column>
          </Card>
        )}
        {section.footer ? (
          <Text
            style={{ typography: 'bodySmall' }}
            color={colors.sectionTextColor}
            modifiers={[padding(spacing[1], spacing[3], spacing[1], 0)]}
          >
            {section.footer}
          </Text>
        ) : null}
      </Column>
    );
  });

  return (
    <ComposeHost style={styles.host}>
      <LazyColumn contentPadding={{ start: spacing[4], top: spacing[4], end: spacing[4], bottom: spacing[10] }}>
        {items}
      </LazyColumn>
    </ComposeHost>
  );
}

const styles = StyleSheet.create({
  // A LazyColumn virtualizes its rows and needs a bounded height to fill.
  host: {
    flex: 1,
  },
});
