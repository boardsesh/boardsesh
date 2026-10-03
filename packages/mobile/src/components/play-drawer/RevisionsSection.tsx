import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ClimbRevisionRow } from '@boardsesh/graphql/operations/climb-revisions';
import { CollapsibleSection } from '../CollapsibleSection';
import { Text } from '../Text';
import { Icon } from '../Icon';
import {
  REVISIONS_INLINE_COUNT,
  formatRevisionDate,
  hasRevisionHistory,
  knownRevisionChanges,
  revisionEditCount,
  type KnownRevisionChange,
} from './revisions-view';
import { useClimbRevisions } from '../../lib/graphql/hooks/use-climb-revisions';
import { CLIMB_REVISION_CAP, climbRevisionCapNote } from '../../lib/spray/spray-cap-copy';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

type RevisionsSectionProps = {
  climbUuid: string;
  boardName: string;
  /**
   * Opens one revision in the play drawer's own in-tree sheet. Absent hides the
   * rows' tap target, and the section is then a plain list.
   */
  onOpenRevision?: (revisionNumber: number) => void;
};

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** One literal key per change kind: the i18n orphan check needs to see each. */
function changeWord(change: KnownRevisionChange, t: Translate): string {
  switch (change) {
    case 'name':
      return t('mobile.revisions.changes.name');
    case 'description':
      return t('mobile.revisions.changes.description');
    case 'holds':
      return t('mobile.revisions.changes.holds');
    case 'grade':
      return t('mobile.revisions.changes.grade');
    case 'angle':
      return t('mobile.revisions.changes.angle');
    case 'rules':
      return t('mobile.revisions.changes.rules');
  }
}

/** What a row says happened: the first publish, the things an edit changed, or just "Edited". */
function describeRevision(row: ClimbRevisionRow, t: Translate): string {
  if (row.revisionNumber === 1) return t('mobile.revisions.published');
  const words = knownRevisionChanges(row.changes).map((change) => changeWord(change, t));
  if (words.length === 0) return t('mobile.revisions.edited');
  return t('mobile.revisions.changed', { changes: words.join(', ') });
}

type RevisionRowProps = {
  row: ClimbRevisionRow;
  onOpenRevision?: (revisionNumber: number) => void;
};

const RevisionRow = memo(function RevisionRow({ row, onOpenRevision }: RevisionRowProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();

  const date = formatRevisionDate(row.createdAt);
  // A climber's own name goes on screen as typed, never through a catalog.
  const editorName = row.editor?.displayName ?? t('mobile.revisions.deletedEditor');
  const handlePress = useCallback(() => onOpenRevision?.(row.revisionNumber), [onOpenRevision, row.revisionNumber]);

  const content = (
    <>
      <View style={styles.rowText}>
        <View style={styles.rowHeader}>
          <Text variant="subheadline" numberOfLines={1}>
            {date}
          </Text>
          {row.isCurrent ? (
            <View style={[styles.tag, { backgroundColor: `${brandColors.primary}1A` }]}>
              <Text variant="caption2" color={brandColors.primary}>
                {t('mobile.revisions.current')}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.rowHeader}>
          <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.editorName}>
            {editorName}
          </Text>
          {row.editor ? (
            <View style={[styles.tag, { borderColor: systemColors.separator, borderWidth: StyleSheet.hairlineWidth }]}>
              <Text variant="caption2" color={systemColors.secondaryLabel}>
                {row.editedBySetter ? t('mobile.revisions.tagSetter') : t('mobile.revisions.tagWallEditor')}
              </Text>
            </View>
          ) : null}
        </View>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {describeRevision(row, t)}
        </Text>
      </View>
      {onOpenRevision ? <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} /> : null}
    </>
  );

  if (!onOpenRevision) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t('mobile.revisions.rowLabel', { date, editor: editorName })}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
    >
      {content}
    </Pressable>
  );
});

/**
 * How a climb has changed since it was published (#5955).
 *
 * Renders nothing at all unless the climb has a history: no rows (never edited,
 * a draft, a wall the viewer cannot see), a single row, still loading, failed
 * and offline all look the same from here, which is no section. The history is
 * a footnote to the climb, and an empty or spinning footnote on every climb in
 * the app would be noise.
 *
 * Collapsed by default. Five rows inline and "Show all" for the rest; the list
 * is capped by the server at `CLIMB_REVISION_CAP`, so a plain `.map()` is
 * bounded and there is nothing to virtualise or page.
 */
export const RevisionsSection = memo(function RevisionsSection({
  climbUuid,
  boardName,
  onOpenRevision,
}: RevisionsSectionProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const { data: revisions } = useClimbRevisions(boardName, climbUuid);
  const [showAll, setShowAll] = useState(false);
  const handleShowAll = useCallback(() => setShowAll(true), []);

  // Never more than the cap, whatever a server sends.
  const rows = useMemo(
    () => (hasRevisionHistory(revisions) ? revisions.slice(0, CLIMB_REVISION_CAP) : null),
    [revisions],
  );
  if (!rows) return null;

  const visibleRows = showAll ? rows : rows.slice(0, REVISIONS_INLINE_COUNT);
  const hiddenCount = rows.length - visibleRows.length;

  // `persistKey` is climb-agnostic, like every sibling section here.
  return (
    <CollapsibleSection
      title={t('mobile.revisions.title')}
      summary={t('mobile.revisions.summary', { count: revisionEditCount(rows) })}
      persistKey="revisions"
    >
      <View style={styles.list}>
        {visibleRows.map((row) => (
          <RevisionRow key={row.revisionNumber} row={row} onOpenRevision={onOpenRevision} />
        ))}
        {hiddenCount > 0 ? (
          <Pressable
            onPress={handleShowAll}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => [styles.showAll, pressed && { opacity: 0.6 }]}
          >
            <Text variant="subheadline" color={brandColors.primary}>
              {t('mobile.revisions.showAll', { count: rows.length })}
            </Text>
          </Pressable>
        ) : null}
        {hiddenCount === 0 && rows.length >= CLIMB_REVISION_CAP ? (
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {climbRevisionCapNote(t)}
          </Text>
        ) : null}
      </View>
    </CollapsibleSection>
  );
});

const styles = StyleSheet.create({
  list: {
    gap: spacing[3],
    paddingBottom: spacing[1],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  editorName: {
    flexShrink: 1,
  },
  tag: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
  },
  showAll: {
    alignSelf: 'flex-start',
    paddingVertical: spacing[1],
  },
});
