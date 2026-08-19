import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getDisplayDescription } from '@boardsesh/shared-schema';
import { CollapsibleSection } from '../CollapsibleSection';
import { Text } from '../Text';
import { spacing } from '../../theme/tokens';

type SetterNotesSectionProps = {
  /** The raw `board_climbs.description` as it came off the wire. */
  description: string | null | undefined;
};

/**
 * The setter's own notes on a climb — the text typed into the create form's
 * description field, which until #4494 was stored and never shown anywhere.
 *
 * Renders nothing at all when there is nothing to say: `getDisplayDescription`
 * strips Aurora's `No match\n` marker line and drops a description that is only
 * a restatement of "no match" (the header's no-match glyph already says that).
 *
 * The text is user-written, so it goes on screen verbatim — never through `t()`.
 */
export function SetterNotesSection({ description }: SetterNotesSectionProps) {
  const { t } = useTranslation('climbs');
  const notes = getDisplayDescription(description);

  if (!notes) return null;

  return (
    <CollapsibleSection title={t('mobile.setterNotes.title')} defaultExpanded persistKey="setterNotes">
      <Text variant="subheadline" style={styles.notes} selectable>
        {notes}
      </Text>
    </CollapsibleSection>
  );
}

const styles = StyleSheet.create({
  notes: {
    paddingBottom: spacing[1],
  },
});
