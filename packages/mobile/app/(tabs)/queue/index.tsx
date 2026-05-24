import { useCallback, useMemo, useState } from 'react';
import { View, Pressable, StyleSheet, RefreshControl, useColorScheme } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueue } from '../../../src/providers/queue-provider';
import { useOptionalBluetoothContext } from '../../../src/providers/bluetooth-provider';
import { QueueItemRow } from '../../../src/components/QueueItemRow';
import { BluetoothStatusIcon } from '../../../src/components/ble/BluetoothStatusIcon';
import { ConnectionBanner } from '../../../src/components/ble/ConnectionBanner';
import { EndSessionSheet } from '../../../src/components/EndSessionSheet';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { Button } from '../../../src/components/Button';
import { LogAscentSheet } from '../../../src/components/LogAscentSheet';
import { hapticSelection } from '../../../src/lib/haptics';
import { useTheme } from '../../../src/providers/theme-provider';
import { useEffectiveDefaultBoard } from '../../../src/lib/hooks/use-effective-default-board';
import type { ClimbQueueItem } from '@boardsesh/queue';

const TAB_BAR_HEIGHT = 49;

export default function QueueScreen() {
  const { state, sessionId, removeFromQueue, setCurrentClimb, nextClimb, previousClimb, endSession } = useQueue();
  const { data: defaultBoard } = useEffectiveDefaultBoard();
  const { systemColors, brandColors } = useTheme();
  const [showLogAscent, setShowLogAscent] = useState(false);
  const [showEndSession, setShowEndSession] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useTranslation('session');

  const bluetooth = useOptionalBluetoothContext();
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Show the banner when an unexpected disconnect occurs, hide when dismissed.
  // bannerDismissed resets when the user reconnects (connect sets
  // disconnectedUnexpectedly to false, which makes showConnectionBanner
  // false regardless of bannerDismissed).
  const showConnectionBanner = !!bluetooth?.disconnectedUnexpectedly && !bannerDismissed;

  const handleBluetoothPress = useCallback(() => {
    if (!bluetooth) return;
    if (bluetooth.isConnected) {
      void bluetooth.disconnect();
    } else {
      setBannerDismissed(false);
      void bluetooth.connect();
    }
  }, [bluetooth]);

  const handleReconnect = useCallback(() => {
    if (!bluetooth) return;
    setBannerDismissed(false);
    void bluetooth.connect();
  }, [bluetooth]);

  const handleDismissBanner = useCallback(() => {
    setBannerDismissed(true);
  }, []);

  const navBarBackground = isDark ? 'rgba(28, 28, 30, 0.95)' : 'rgba(255, 255, 255, 0.95)';
  const navBarBottomPadding = insets.bottom + TAB_BAR_HEIGHT;

  const { queue, currentClimbQueueItem } = state;

  const currentClimbIndex = useMemo(() => {
    if (!currentClimbQueueItem) return -1;
    return queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
  }, [queue, currentClimbQueueItem]);

  const hasPrevious = currentClimbIndex > 0;
  const hasNext = currentClimbIndex >= 0 && currentClimbIndex < queue.length - 1;

  const handlePrevious = useCallback(() => {
    hapticSelection();
    previousClimb();
  }, [previousClimb]);

  const handleNext = useCallback(() => {
    hapticSelection();
    nextClimb();
  }, [nextClimb]);

  const handleLogAscent = useCallback(() => {
    hapticSelection();
    setShowLogAscent(true);
  }, []);

  const handleEndSessionPress = useCallback(() => {
    hapticSelection();
    setShowEndSession(true);
  }, []);

  const handleEndSessionConfirm = useCallback(async () => {
    setIsEnding(true);
    const summary = await endSession();
    setIsEnding(false);
    setShowEndSession(false);
    if (summary) {
      router.push({ pathname: '/(tabs)/queue/summary', params: { sessionId: summary.sessionId } });
    }
  }, [endSession, router]);

  const handleItemPress = useCallback(
    (item: ClimbQueueItem) => {
      setCurrentClimb(item);
    },
    [setCurrentClimb],
  );

  const handleItemRemove = useCallback(
    (uuid: string) => {
      removeFromQueue(uuid);
    },
    [removeFromQueue],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: ClimbQueueItem; index: number }) => {
      const isActive = currentClimbQueueItem?.uuid === item.uuid;
      return (
        <QueueItemRow
          item={item}
          position={index + 1}
          isCurrentClimb={isActive}
          onPress={handleItemPress}
          onRemove={handleItemRemove}
        />
      );
    },
    [currentClimbQueueItem?.uuid, handleItemPress, handleItemRemove],
  );

  const keyExtractor = useCallback((item: ClimbQueueItem) => item.uuid, []);

  // No active session state
  if (!sessionId) {
    return (
      <View style={styles.emptyContainer}>
        <Animated.View entering={FadeIn.duration(300)} style={styles.emptyContent}>
          <Icon name="people" size={48} color={systemColors.secondaryLabel} />
          <Text variant="title3" color={systemColors.label} style={styles.emptyTitle}>
            {t('mobile.queue.noSessionTitle')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptySubtitle}>
            {t('mobile.queue.noSessionSubtitle')}
          </Text>
        </Animated.View>
      </View>
    );
  }

  // Empty queue state
  if (queue.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Animated.View entering={FadeIn.duration(300)} style={styles.emptyContent}>
          <Icon name="queue" size={48} color={systemColors.secondaryLabel} />
          <Text variant="title3" color={systemColors.label} style={styles.emptyTitle}>
            {t('mobile.queue.emptyTitle')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptySubtitle}>
            {t('mobile.queue.emptySubtitle')}
          </Text>
          <Button
            title={t('mobile.queue.browseClimbs')}
            variant="filled"
            size="medium"
            icon="search"
            onPress={() => {
              router.navigate('/(tabs)/climbs');
            }}
            style={styles.browseButton}
          />
        </Animated.View>
      </View>
    );
  }

  // Queue list
  return (
    <View style={styles.container}>
      {bluetooth && (
        <ConnectionBanner
          visible={showConnectionBanner}
          onReconnect={handleReconnect}
          onDismiss={handleDismissBanner}
        />
      )}

      <FlashList
        data={queue}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        estimatedItemSize={64}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => {
              // A pull-to-refresh would trigger a full resync request.
              // The subscription will deliver a FullSync event automatically
              // when the WS reconnects. For now this is a no-op placeholder.
            }}
            tintColor={brandColors.primary}
          />
        }
        contentContainerStyle={styles.listContent}
      />

      {/* Navigation controls */}
      <Animated.View
        entering={FadeIn.duration(200)}
        style={[
          styles.navBar,
          {
            backgroundColor: navBarBackground,
            borderTopColor: systemColors.separator,
            paddingBottom: navBarBottomPadding,
          },
        ]}
      >
        <Pressable
          onPress={handlePrevious}
          disabled={!hasPrevious}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.queue.previousClimb')}
          accessibilityState={{ disabled: !hasPrevious }}
          style={[styles.navButton, !hasPrevious && styles.navButtonDisabled]}
          hitSlop={8}
        >
          <Icon name="chevron.left" size={22} color={hasPrevious ? brandColors.primary : systemColors.secondaryLabel} />
        </Pressable>

        <View style={styles.navClimbInfo}>
          {currentClimbQueueItem ? (
            <>
              <Text variant="subheadline" numberOfLines={1} color={systemColors.label} style={styles.navClimbName}>
                {currentClimbQueueItem.climb?.name ?? t('mobile.queue.unknownClimb')}
              </Text>
              {currentClimbQueueItem.climb?.difficulty ? (
                <Text variant="caption1" color={systemColors.secondaryLabel}>
                  {currentClimbQueueItem.climb.difficulty}
                </Text>
              ) : null}
            </>
          ) : (
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('mobile.queue.noClimbSelected')}
            </Text>
          )}
        </View>

        <Pressable
          onPress={handleNext}
          disabled={!hasNext}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.queue.nextClimb')}
          accessibilityState={{ disabled: !hasNext }}
          style={[styles.navButton, !hasNext && styles.navButtonDisabled]}
          hitSlop={8}
        >
          <Icon name="chevron.right" size={22} color={hasNext ? brandColors.primary : systemColors.secondaryLabel} />
        </Pressable>

        <Pressable
          onPress={handleLogAscent}
          disabled={!currentClimbQueueItem}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.queue.logAscent')}
          style={[styles.navButton, !currentClimbQueueItem && styles.navButtonDisabled]}
          hitSlop={8}
        >
          <Icon
            name="tick"
            size={22}
            color={currentClimbQueueItem ? brandColors.primary : systemColors.secondaryLabel}
          />
        </Pressable>

        {bluetooth && (
          <BluetoothStatusIcon
            isConnected={bluetooth.isConnected}
            isScanning={bluetooth.loading}
            onPress={handleBluetoothPress}
          />
        )}

        <Pressable
          onPress={handleEndSessionPress}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.queue.endSession')}
          style={styles.navButton}
          hitSlop={8}
        >
          <Icon name="end.session" size={22} color={brandColors.error} />
        </Pressable>
      </Animated.View>

      {currentClimbQueueItem && defaultBoard && (
        <LogAscentSheet
          visible={showLogAscent}
          onDismiss={() => setShowLogAscent(false)}
          climbUuid={currentClimbQueueItem.climb.uuid}
          climbName={currentClimbQueueItem.climb.name}
          boardName={defaultBoard.boardType}
          angle={currentClimbQueueItem.climb.angle}
          isMirror={currentClimbQueueItem.climb.mirrored === true}
          isBenchmark={currentClimbQueueItem.climb.benchmark_difficulty != null}
          layoutId={defaultBoard.layoutId}
          sizeId={defaultBoard.sizeId}
          setIds={defaultBoard.setIds}
          sessionId={sessionId}
        />
      )}

      <EndSessionSheet
        visible={showEndSession}
        onDismiss={() => setShowEndSession(false)}
        onConfirm={handleEndSessionConfirm}
        isEnding={isEnding}
        climbCount={queue.length}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 80, // Space for the nav bar
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyContent: {
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: {
    textAlign: 'center',
    marginTop: 8,
  },
  emptySubtitle: {
    textAlign: 'center',
    lineHeight: 20,
  },
  browseButton: {
    marginTop: 16,
  },
  navBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  navButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  navButtonDisabled: {
    opacity: 0.4,
  },
  navClimbInfo: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  navClimbName: {
    fontWeight: '600',
    textAlign: 'center',
  },
});
