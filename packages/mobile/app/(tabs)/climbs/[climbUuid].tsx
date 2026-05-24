import { useMemo, useCallback, useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet, Image } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { randomUUID } from 'expo-crypto';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { Button } from '../../../src/components/Button';
import { Icon } from '../../../src/components/Icon';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { BoardRenderer } from '../../../src/components/board-renderer';
import { LogAscentSheet } from '../../../src/components/LogAscentSheet';
import { SignInPromptSheet } from '../../../src/components/SignInPromptSheet';
import { useClimb, useToggleFavorite } from '../../../src/lib/graphql/hooks';
import { useQueue } from '../../../src/providers/queue-provider';
import { useAuth } from '../../../src/providers/auth-provider';
import { getBoardRenderData } from '../../../src/lib/board-details';
import { hapticSuccess } from '../../../src/lib/haptics';
import { brandColors } from '../../../src/theme/colors';
import { spacing } from '../../../src/theme/tokens';

type AuthGate = 'favorite' | 'logAscent' | null;

type ClimbDetailParams = {
  climbUuid: string;
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
};

export default function ClimbDetail() {
  const params = useLocalSearchParams<ClimbDetailParams>();
  const { climbUuid, boardName, layoutId, sizeId, setIds, angle } = params;
  const { t } = useTranslation('climbs');
  const { t: tAuth } = useTranslation('auth');
  const { isAuthenticated } = useAuth();
  const [authGate, setAuthGate] = useState<AuthGate>(null);

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
  const toggleFavorite = useToggleFavorite();
  const { sessionId, addToQueue } = useQueue();
  const [showLogAscent, setShowLogAscent] = useState(false);

  const boardRenderData = useMemo(() => {
    if (!boardName || !layoutId || !sizeId || !setIds) return null;
    const parsedSetIds = setIds.split(',').map(Number);
    return getBoardRenderData({
      boardName: boardName as BoardName,
      layoutId: Number(layoutId),
      sizeId: Number(sizeId),
      setIds: parsedSetIds,
    });
  }, [boardName, layoutId, sizeId, setIds]);

  // Pre-warm React Native's platform image cache for board images
  useEffect(() => {
    if (boardRenderData?.imageUrls) {
      for (const url of boardRenderData.imageUrls) {
        Image.prefetch(url);
      }
    }
  }, [boardRenderData?.imageUrls]);

  const gradeInfo = useMemo(() => {
    if (!climb) return null;
    const color = getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR;
    return { name: climb.difficulty, color };
  }, [climb]);

  const handleToggleFavorite = useCallback(() => {
    if (!climb || !boardName) return;
    if (!isAuthenticated) {
      setAuthGate('favorite');
      return;
    }
    hapticSuccess();
    toggleFavorite.mutate({
      input: {
        boardName,
        climbUuid: climb.uuid,
        angle: Number(angle),
      },
    });
  }, [climb, boardName, angle, toggleFavorite, isAuthenticated]);

  const handleLogAscentPress = useCallback(() => {
    if (!isAuthenticated) {
      setAuthGate('logAscent');
      return;
    }
    setShowLogAscent(true);
  }, [isAuthenticated]);

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

  const qualityNum = parseFloat(climb.quality_average);
  const showStars = climb.stars > 0 || qualityNum > 0;

  return (
    <>
      <ScrollView style={styles.container} contentInsetAdjustmentBehavior="automatic">
        {/* Board visualization */}
        {boardRenderData && (
          <View style={styles.boardContainer}>
            <BoardRenderer
              frames={climb.frames}
              boardName={boardName as BoardName}
              boardWidth={boardRenderData.boardWidth}
              boardHeight={boardRenderData.boardHeight}
              imageUrls={boardRenderData.imageUrls}
              holdsData={boardRenderData.holdsData}
              mirrored={climb.mirrored === true}
            />
          </View>
        )}

        {/* Climb info */}
        <View style={styles.infoSection}>
          <Text variant="title2">{climb.name}</Text>
          <Text variant="subheadline" style={styles.setter}>
            {climb.setter_username}
          </Text>

          {/* Stats row */}
          <View style={styles.statsRow}>
            {gradeInfo && (
              <View style={[styles.gradePill, { backgroundColor: gradeInfo.color }]}>
                <Text variant="footnote" color="#FFFFFF" style={styles.gradeText}>
                  {gradeInfo.name}
                </Text>
              </View>
            )}

            {showStars && (
              <View style={styles.statItem}>
                <Icon name="star.fill" size={14} color="#FFB800" />
                <Text variant="footnote">{climb.stars > 0 ? climb.stars.toFixed(1) : qualityNum.toFixed(1)}</Text>
              </View>
            )}

            <View style={styles.statItem}>
              <Icon name="person" size={14} color="#8E8E93" />
              <Text variant="footnote" style={styles.statLabel}>
                {climb.ascensionist_count} {t('mobile.detail.send', { count: climb.ascensionist_count })}
              </Text>
            </View>

            {climb.angle > 0 && (
              <View style={styles.statItem}>
                <Text variant="footnote" style={styles.statLabel}>
                  {climb.angle}°
                </Text>
              </View>
            )}
          </View>

          {/* User progress */}
          {climb.userAscents != null && climb.userAscents > 0 && (
            <View style={styles.progressRow}>
              <Icon name="tick" size={16} color={brandColors.success} />
              <Text variant="footnote" style={styles.progressText}>
                {climb.userAttempts != null && climb.userAttempts > 0
                  ? t('mobile.detail.sentWithAttempts', {
                      count: climb.userAscents,
                      attempts: climb.userAttempts,
                      attemptWord: t('mobile.detail.attempt', { count: climb.userAttempts }),
                    })
                  : t('mobile.detail.sent', { count: climb.userAscents })}
              </Text>
            </View>
          )}

          {/* Description */}
          {climb.description && climb.description.length > 0 && (
            <Text variant="body" style={styles.description}>
              {climb.description}
            </Text>
          )}
        </View>

        {/* Action buttons */}
        <View style={styles.actions}>
          <Button
            title={t('mobile.detail.addToQueue')}
            icon="queue"
            variant="filled"
            size="large"
            onPress={() => {
              if (!climb) return;
              hapticSuccess();
              addToQueue({
                uuid: randomUUID(),
                climb: {
                  uuid: climb.uuid,
                  name: climb.name,
                  frames: climb.frames,
                  setter_username: climb.setter_username,
                  angle: climb.angle,
                  ascensionist_count: climb.ascensionist_count,
                  difficulty: climb.difficulty,
                  quality_average: climb.quality_average,
                  stars: climb.stars,
                  difficulty_error: climb.difficulty_error,
                  benchmark_difficulty: climb.benchmark_difficulty,
                },
              });
            }}
            style={styles.actionButton}
          />
          <View style={styles.secondaryActions}>
            <Button
              title={t('actions.favorite.label.favorite')}
              icon="favorite"
              variant="outlined"
              size="medium"
              onPress={handleToggleFavorite}
              loading={toggleFavorite.isPending}
              style={styles.secondaryButton}
            />
            <Button
              title={t('mobile.detail.logAscent')}
              icon="tick.outline"
              variant="outlined"
              size="medium"
              onPress={handleLogAscentPress}
              style={styles.secondaryButton}
            />
          </View>
        </View>
      </ScrollView>

      {/* Log Ascent sheet */}
      {boardName && isAuthenticated && (
        <LogAscentSheet
          visible={showLogAscent}
          onDismiss={() => setShowLogAscent(false)}
          climbUuid={climb.uuid}
          climbName={climb.name}
          boardName={boardName}
          angle={Number(angle)}
          isMirror={climb.mirrored === true}
          isBenchmark={climb.benchmark_difficulty != null}
          layoutId={layoutId ? Number(layoutId) : undefined}
          sizeId={sizeId ? Number(sizeId) : undefined}
          setIds={setIds}
          sessionId={sessionId}
        />
      )}

      <SignInPromptSheet
        visible={authGate !== null}
        onDismiss={() => setAuthGate(null)}
        title={
          authGate === 'favorite'
            ? tAuth('nativeStart.prompt.favoriteTitle')
            : tAuth('nativeStart.prompt.logAscentTitle')
        }
        description={
          authGate === 'favorite'
            ? tAuth('nativeStart.prompt.favoriteDescription')
            : tAuth('nativeStart.prompt.logAscentDescription')
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  errorText: {
    opacity: 0.6,
  },
  boardContainer: {
    marginHorizontal: spacing[4],
    marginTop: spacing[4],
    borderRadius: 16,
    overflow: 'hidden',
  },
  infoSection: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[5],
  },
  setter: {
    opacity: 0.6,
    marginTop: 4,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: spacing[3],
  },
  gradePill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  gradeText: {
    fontWeight: '600',
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statLabel: {
    opacity: 0.6,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing[3],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    backgroundColor: 'rgba(107, 144, 128, 0.1)',
    borderRadius: 8,
  },
  progressText: {
    color: brandColors.success,
  },
  description: {
    marginTop: spacing[4],
    opacity: 0.8,
  },
  actions: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[6],
    paddingBottom: spacing[10],
    gap: spacing[3],
  },
  actionButton: {
    width: '100%',
  },
  secondaryActions: {
    flexDirection: 'row',
    gap: spacing[3],
  },
  secondaryButton: {
    flex: 1,
  },
});
