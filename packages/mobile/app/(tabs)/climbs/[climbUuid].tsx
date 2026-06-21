import { useMemo, useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { useClimb } from '../../../src/lib/graphql/hooks';
import { useDrawerHost } from '../../../src/providers/drawer-host-provider';
import { openClimbInPlayDrawer } from '../../../src/lib/open-climb-in-play-drawer';

type ClimbDetailParams = {
  climbUuid: string;
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
};

/**
 * The standalone climb page is gone — every climb opens in the play drawer. This
 * route survives only as a deep-link / fallback target (the `ref` branch of
 * `openClimbInPlayDrawer` routes here when a caller has a uuid but no frames).
 * It loads the full climb by uuid, hands it to the play drawer once, then pops —
 * so all it ever renders is a spinner (while loading) or the not-found block.
 */
export default function ClimbDetail() {
  const params = useLocalSearchParams<ClimbDetailParams>();
  const { climbUuid, boardName, layoutId, sizeId, setIds, angle } = params;
  const { t } = useTranslation('climbs');
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();

  const hasRequiredParams = boardName && layoutId && sizeId && setIds && angle;

  const climbVariables = useMemo(() => {
    if (!hasRequiredParams) return null;
    return {
      boardName: boardName!,
      layoutId: Number(layoutId),
      sizeId: Number(sizeId),
      setIds: setIds!,
      angle: Number(angle),
      climbUuid,
    };
  }, [climbUuid, boardName, layoutId, sizeId, setIds, angle, hasRequiredParams]);

  const { data: climb, isLoading } = useClimb(climbVariables);

  // Hand off to the play drawer exactly once, then pop this redirector. The ref
  // guards against the open firing again on a re-render (or after `router.back`
  // can't pop and we fall through to a replace).
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    if (!climb || !hasRequiredParams) return;
    firedRef.current = true;
    // preview:true so a deep-linked climb doesn't disturb the queue (in a session
    // it would change the shared current climb for everyone). The drawer shows it
    // with a "Preview" badge + "Set active" to opt into playing it.
    openClimbInPlayDrawer(
      {
        kind: 'climb',
        climb,
        boardConfig: {
          boardName: boardName!,
          layoutId: Number(layoutId),
          sizeId: Number(sizeId),
          setIds: setIds!,
          angle: Number(angle),
        },
      },
      { openPlayDrawer, router },
      { preview: true },
    );
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/climbs');
    }
  }, [climb, hasRequiredParams, boardName, layoutId, sizeId, setIds, angle, openPlayDrawer, router]);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!climb) {
    return (
      <View style={styles.loadingContainer}>
        <Icon name="error" size={48} color="#C7C7CC" />
        <Text variant="headline" style={styles.errorText}>
          {t('mobile.detail.notFound')}
        </Text>
      </View>
    );
  }

  // Climb resolved: the effect opens the drawer and pops. Keep the spinner up for
  // the one frame before the pop so nothing else flashes on screen.
  return (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  errorText: {
    opacity: 0.6,
  },
});
