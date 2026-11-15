import { StyleSheet } from 'react-native';
import { spacing, borderRadius } from '../../theme/tokens';
export const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[3],
    paddingBottom: spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerAction: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    marginHorizontal: spacing[2],
    textAlign: 'center',
  },
  fillList: {
    flex: 1,
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    margin: spacing[4],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
  },
  heroInteractiveContainer: {
    margin: spacing[4],
    borderRadius: borderRadius.lg,
  },
  heroInteractiveRow: {
    padding: spacing[3],
    borderRadius: borderRadius.lg,
  },
  heroBody: {
    flex: 1,
    gap: 2,
  },
  heroNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  heroName: {
    flex: 1,
  },
  heroDriverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    // Headroom for the badge that pokes ~2pt past the avatar's top-right corner.
    paddingTop: 2,
  },
  heroDriverName: {
    flexShrink: 1,
  },
  heroGrade: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  sectionHeader: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  statsBlock: {
    paddingBottom: spacing[2],
  },
  statTiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  statTile: {
    flexGrow: 1,
    flexBasis: '47%',
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.md,
    gap: 2,
  },
  hardestSendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.md,
  },
  hardestAvatar: {
    width: 42,
    height: 42,
    justifyContent: 'flex-end',
  },
  crownBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hardestBody: {
    flex: 1,
    gap: 2,
  },
  hardestName: {
    fontWeight: '600',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  historyInteractiveRow: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  historyBody: {
    flex: 1,
    gap: 2,
  },
  historyName: {
    fontWeight: '600',
  },
  historyDriverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  historyDriverName: {
    flexShrink: 1,
  },
  historySentAgo: {
    flexShrink: 0,
    // Pulls back half of the row's gap so "Name · 2 minutes ago" reads with
    // the same spacing as the single-Text Kilter line.
    marginLeft: -spacing[1],
  },
  historyGrade: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    minWidth: 40,
    textAlign: 'right',
  },
  actionSpinner: {
    width: 20,
    height: 20,
  },
  empty: {
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[8],
  },
  emptyTitle: {
    textAlign: 'center',
  },
  emptyBody: {
    textAlign: 'center',
  },
  historyFooter: {
    paddingVertical: spacing[5],
    alignItems: 'center',
  },
});
