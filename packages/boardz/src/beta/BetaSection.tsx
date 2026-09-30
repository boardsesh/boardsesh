import { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View, useWindowDimensions } from 'react-native';
import { isBetaVideoUrl, type BoardName } from '@boardsesh/shared-schema';
import { Button } from '../ui/Button';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';
import { useTheme } from '../ui/theme';
import { GUTTER, radius, spacing } from '../ui/tokens';
import { BetaVideoThumb } from './BetaVideoThumb';
import { useBetaLinks } from './use-beta-links';

const COLUMNS = 3;
const GAP = 10;
// Two rows before "Show all".
const FIRST_LOOK = 6;

type BetaSectionProps = { boardName: BoardName; climbUuid: string; angle: number };

/** Beta videos for the climb on screen, three to a row. */
export function BetaSection({ boardName, climbUuid, angle }: BetaSectionProps) {
  const theme = useTheme();
  const toast = useToast();
  const { width: windowWidth } = useWindowDimensions();
  const { videos, isPending, isError } = useBetaLinks(boardName, climbUuid, angle);
  const [showAll, setShowAll] = useState(false);
  const cardWidth = (windowWidth - GUTTER * 2 - GAP * (COLUMNS - 1)) / COLUMNS;
  const shown = showAll ? videos : videos.slice(0, FIRST_LOOK);

  const open = async (link: string) => {
    // Only hand the system a URL we recognise as a beta video.
    const opened =
      isBetaVideoUrl(link) &&
      (await Linking.openURL(link).then(
        () => true,
        () => false,
      ));
    if (!opened) toast.show({ tone: 'danger', title: "Couldn't open that video", message: 'Try again in a moment.' });
  };

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text variant="label" accessibilityRole="header">
          Beta{videos.length > 0 ? ` · ${videos.length}` : ''}
        </Text>
      </View>
      {isPending ? (
        <ActivityIndicator style={styles.loading} />
      ) : isError ? (
        <Text variant="small" tone="tertiary">
          Couldn&apos;t load beta. Pull down to try again.
        </Text>
      ) : videos.length === 0 ? (
        <View style={[styles.empty, { borderColor: theme.border2 }]}>
          <Text variant="title3">No beta yet.</Text>
          <Text variant="small" tone="tertiary">
            Be the first to film it.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.grid}>
            {shown.map((video) => (
              <BetaVideoThumb key={video.link} video={video} width={cardWidth} onPress={() => void open(video.link)} />
            ))}
          </View>
          {videos.length > FIRST_LOOK ? (
            <Button
              title={showAll ? 'Show fewer' : `Show all ${videos.length}`}
              variant="ghost"
              size="sm"
              onPress={() => setShowAll(!showAll)}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  loading: { paddingVertical: spacing.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: GAP, rowGap: spacing.md },
  empty: {
    alignItems: 'center',
    gap: 2,
    paddingVertical: 28,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
});
