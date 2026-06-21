import { memo, useCallback, useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { parseBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol';
import type { DiscoveredDevice } from '../../lib/ble/types';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import { configFromResolvedEntry, type BleBoardConfig } from '../../lib/ble/board-config-match';
import { getBoardRenderData } from '../../lib/board-details';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { formatRelativeTime } from '../../lib/format-relative-time';

type RssiStrength = 'strong' | 'good' | 'weak';

function classifyRssi(rssi: number): RssiStrength {
  if (rssi > -60) return 'strong';
  if (rssi > -80) return 'good';
  return 'weak';
}

const rssiBarColor: Record<RssiStrength, string> = {
  strong: iosSystemColors.systemGreen,
  good: iosSystemColors.systemYellow,
  weak: iosSystemColors.systemRed,
};

const PREVIEW_SIZE = 64;
const PREVIEW_IMAGE_MAX_SIZE = 58;

function RssiIndicator({ rssi }: { rssi: number }) {
  const { systemColors } = useTheme();
  const strength = classifyRssi(rssi);
  const activeColor = rssiBarColor[strength];
  const inactiveColor = systemColors.fill;

  const barHeights = [8, 13, 18];
  const activeBars = strength === 'strong' ? 3 : strength === 'good' ? 2 : 1;

  return (
    <View style={styles.rssiContainer}>
      {barHeights.map((height, index) => (
        <View
          key={index}
          style={[
            styles.rssiBar,
            {
              height,
              backgroundColor: index < activeBars ? activeColor : inactiveColor,
            },
          ]}
        />
      ))}
    </View>
  );
}

type DeviceCardProps = {
  device: DiscoveredDevice;
  onSelect: (deviceId: string) => void;
  /**
   * The serial-resolution result for THIS device (not the whole map): rows
   * whose entry didn't change keep referentially identical props, so the
   * React.memo wrapper skips them when another row's resolution arrives.
   */
  resolvedEntry?: ResolvedBoardEntry;
  currentBoardConfig?: BleBoardConfig;
};

type DevicePresentation = {
  title: string;
  subtitle?: string;
  previewConfig?: BleBoardConfig;
  isUnknown: boolean;
};

function parseSetIds(setIds: string): number[] {
  return (
    setIds
      .split(',')
      .map((setId) => Number(setId.trim()))
      // `Number('')` is 0, so a malformed "1,,20" would otherwise yield a bogus
      // set ID 0 — real set IDs are positive.
      .filter((setId) => Number.isInteger(setId) && setId > 0)
  );
}

// Exported for testing.
export function describeSavedBoard(entry: Extract<ResolvedBoardEntry, { kind: 'saved' }>): string | undefined {
  const location = entry.board.gymName ?? entry.board.locationName ?? undefined;
  const boardSpecs = [entry.board.layoutName, entry.board.sizeName, entry.board.setNames?.join(', ')]
    .filter((part) => part && part.length > 0)
    .join(', ');
  return [location, boardSpecs].filter((part) => part && part.length > 0).join(', ') || undefined;
}

type PreviewImageStyle = {
  width: number;
  height: number;
};

// Exported for testing.
export function getPreviewImageStyle(boardWidth: number, boardHeight: number): PreviewImageStyle {
  // A corrupt config (zero/negative/non-finite dimension) would otherwise
  // produce an invisible zero-height strip — fall back to a square thumbnail.
  if (!Number.isFinite(boardWidth) || !Number.isFinite(boardHeight) || boardWidth <= 0 || boardHeight <= 0) {
    return { width: PREVIEW_IMAGE_MAX_SIZE, height: PREVIEW_IMAGE_MAX_SIZE };
  }
  const aspectRatio = boardWidth / boardHeight;
  if (aspectRatio >= 1) {
    return {
      width: PREVIEW_IMAGE_MAX_SIZE,
      height: PREVIEW_IMAGE_MAX_SIZE / aspectRatio,
    };
  }
  return {
    width: PREVIEW_IMAGE_MAX_SIZE * aspectRatio,
    height: PREVIEW_IMAGE_MAX_SIZE,
  };
}

function BoardPreview({ previewConfig, isUnknown }: { previewConfig?: BleBoardConfig; isUnknown: boolean }) {
  const { systemColors } = useTheme();
  const setIds = useMemo(() => (previewConfig ? parseSetIds(previewConfig.setIds) : []), [previewConfig]);
  const preview = useMemo(() => {
    if (!previewConfig || setIds.length === 0) return null;
    const renderData = getBoardRenderData({
      boardName: previewConfig.boardName,
      layoutId: previewConfig.layoutId,
      sizeId: previewConfig.sizeId,
      setIds,
    });
    if (!renderData) return null;
    return {
      renderData,
      imageStyle: getPreviewImageStyle(renderData.boardWidth, renderData.boardHeight),
    };
  }, [previewConfig, setIds]);

  return (
    <View style={[styles.preview, { backgroundColor: systemColors.tertiaryBackground }]}>
      {previewConfig && preview ? (
        <BoardImageNative
          frames=""
          boardName={previewConfig.boardName}
          layoutId={previewConfig.layoutId}
          sizeId={previewConfig.sizeId}
          setIds={previewConfig.setIds}
          boardWidth={preview.renderData.boardWidth}
          boardHeight={preview.renderData.boardHeight}
          renderWidth={Math.round(preview.imageStyle.width)}
          style={preview.imageStyle}
        />
      ) : (
        <Icon name="boards" size={30} color={systemColors.tertiaryLabel} />
      )}
      {isUnknown ? (
        <View style={[styles.unknownBadge, { backgroundColor: systemColors.background }]}>
          <Icon name="info" size={14} color={systemColors.tertiaryLabel} />
        </View>
      ) : null}
    </View>
  );
}

export const DeviceCard = memo(function DeviceCard({
  device,
  onSelect,
  resolvedEntry,
  currentBoardConfig,
}: DeviceCardProps) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const serialNumber = parseSerialNumber(device.name);
  const inferredBoardType = parseBoardTypeFromDeviceName(device.name);

  const handlePress = useCallback(() => {
    hapticLight();
    onSelect(device.deviceId);
  }, [device.deviceId, onSelect]);

  const presentation = useMemo<DevicePresentation>(() => {
    if (resolvedEntry?.kind === 'saved') {
      return {
        title: resolvedEntry.board.name,
        subtitle: describeSavedBoard(resolvedEntry),
        previewConfig: configFromResolvedEntry(resolvedEntry),
        isUnknown: false,
      };
    }

    if (resolvedEntry?.kind === 'recorded') {
      return {
        title: device.name ?? t('devicePicker.lastConnected'),
        subtitle: t('devicePicker.lastConnectedAt', { time: formatRelativeTime(resolvedEntry.config.updatedAt) }),
        previewConfig: configFromResolvedEntry(resolvedEntry),
        isUnknown: false,
      };
    }

    return {
      title: device.name ?? t('devicePicker.unknownDevice'),
      previewConfig:
        !inferredBoardType || inferredBoardType === currentBoardConfig?.boardName ? currentBoardConfig : undefined,
      isUnknown: true,
    };
  }, [currentBoardConfig, device.name, inferredBoardType, resolvedEntry, t]);

  const boardType = presentation.previewConfig?.boardName ?? inferredBoardType;
  const boardLabel = boardType ? formatBoardDisplayName(boardType) : undefined;

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={presentation.title}
      style={({ pressed }) => [
        styles.container,
        {
          backgroundColor: pressed ? systemColors.fill : systemColors.secondaryBackground,
        },
      ]}
    >
      <BoardPreview previewConfig={presentation.previewConfig} isUnknown={presentation.isUnknown} />

      <View style={styles.centerSection}>
        <Text variant="body" color={systemColors.label} numberOfLines={1}>
          {presentation.title}
        </Text>

        {presentation.subtitle ? (
          <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
            {presentation.subtitle}
          </Text>
        ) : null}

        <View style={styles.metaRow}>
          {boardLabel && (
            <View style={[styles.badge, { backgroundColor: systemColors.fill }]}>
              <Text variant="caption2" color={systemColors.secondaryLabel}>
                {boardLabel}
              </Text>
            </View>
          )}
          {serialNumber && (
            <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1}>
              #{serialNumber}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.rightSection}>
        <RssiIndicator rssi={device.rssi} />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.lg,
    gap: spacing[3],
  },
  preview: {
    width: PREVIEW_SIZE,
    height: PREVIEW_SIZE,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  unknownBadge: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerSection: {
    flex: 1,
    gap: spacing[1],
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  badge: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  rightSection: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rssiContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 18,
  },
  rssiBar: {
    width: 4,
    borderRadius: 1,
  },
});
