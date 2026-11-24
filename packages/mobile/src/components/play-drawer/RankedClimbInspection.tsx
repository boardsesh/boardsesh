import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Circle, Polygon } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { parseSetIds } from '@boardsesh/board-config';
import { SUPPORTED_BOARDS, type BoardName, type Climb } from '@boardsesh/shared-schema';
import { convertLitUpHoldsStringToMap, toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { useBoardAccessibilitySummary } from '../../hooks/use-board-accessibility-summary';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { getCatalogueBoardRenderData } from '../../lib/board-details';
import { bundledBoardArtSource } from '../../lib/bundled-board-art';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { MoonBoardGridLabels } from '../board/MoonBoardGridLabels';
import { Button } from '../Button';
import { Text } from '../Text';
import type { BoardConfig, RankedClimbPreview, RankedSprayArt } from './play-drawer-types';

type LitHold = RankedSprayArt['holds'][number];

const closedOnServer = () => false;

export function RankedClimbInspection({
  climb,
  preview,
  onClose,
}: {
  climb: Climb;
  preview: RankedClimbPreview;
  onClose?: () => void;
}) {
  const { t, i18n } = useTranslation(['boards', 'climbs']);
  const { formatGradeByDifficultyId } = useGradeFormat();
  const { authorization, boardConfig, referenceDifficulty, sprayArt } = preview;
  const authorized = useSyncExternalStore(authorization.subscribe, authorization.isCurrent, closedOnServer);
  const boardName = SUPPORTED_BOARDS.find((name) => name === boardConfig.boardName);
  const close = onClose && <Button title={t('gymReporting.rankings.close')} onPress={onClose} />;
  if (!authorized || !boardName || (boardName === 'spray' && !sprayArt)) {
    return (
      <SafeAreaView style={styles.expired}>
        <Text accessibilityRole="alert">{t('gymReporting.rankings.climbUnavailable')}</Text>
        {close}
      </SafeAreaView>
    );
  }
  const name = climb.name || t('climbs:similarClimbs.untitledClimb');
  const grade = formatGradeByDifficultyId(referenceDifficulty, boardName);
  const angle = new Intl.NumberFormat(i18n.language || 'en-US').format(boardConfig.angle);
  const orientation = t(
    climb.mirrored ? 'gymReporting.rankings.mirroredAngle' : 'gymReporting.rankings.originalAngle',
    { angle },
  );
  return (
    <SafeAreaView style={styles.preview}>
      <Text accessibilityRole="header" variant="title2">
        {name}
      </Text>
      <Text variant="subheadline">{grade ? `${grade} · ${orientation}` : orientation}</Text>
      {sprayArt ? (
        <InspectionArt
          boardName={boardName}
          frames={climb.frames}
          name={name}
          width={sprayArt.width}
          height={sprayArt.height}
          holds={sprayArt.holds}
        >
          <Image
            style={StyleSheet.absoluteFill}
            source={{ uri: sprayArt.uri }}
            contentFit="contain"
            cachePolicy="none"
            accessible={false}
          />
        </InspectionArt>
      ) : (
        <CatalogueInspectionArt
          boardName={boardName}
          config={boardConfig}
          name={name}
          frames={climb.frames}
          mirrored={climb.mirrored === true}
        />
      )}
      {close}
    </SafeAreaView>
  );
}

function CatalogueInspectionArt({
  boardName,
  config,
  name,
  frames,
  mirrored,
}: {
  boardName: BoardName;
  config: BoardConfig;
  name: string;
  frames: string;
  mirrored: boolean;
}) {
  const { t } = useTranslation('boards');
  const { colorScheme } = useTheme();
  const { layoutId, sizeId, setIds } = config;
  const drawing = useMemo(() => {
    const board = getCatalogueBoardRenderData({ boardName, layoutId, sizeId, setIds: parseSetIds(setIds) });
    if (!board) return null;
    const lit = convertLitUpHoldsStringToMap(toFlatFrames(frames, boardName), boardName)[0] ?? {};
    return {
      ...board,
      holds: board.holdsData
        .filter(({ id }) => lit[id])
        .map(({ id, cx, cy, r }) => ({
          id,
          cx,
          cy,
          r,
          color: lit[id].displayColor || lit[id].color,
        })),
    };
  }, [boardName, frames, layoutId, setIds, sizeId]);
  if (!drawing) {
    return <Text accessibilityRole="alert">{t('gymReporting.rankings.climbUnavailable')}</Text>;
  }
  return (
    <InspectionArt
      boardName={boardName}
      frames={frames}
      name={name}
      width={drawing.boardWidth}
      height={drawing.boardHeight}
      holds={drawing.holds}
      mirrored={mirrored}
      labels={boardName === 'moonboard' ? <MoonBoardGridLabels layoutId={layoutId} colorScheme={colorScheme} /> : null}
    >
      {drawing.backgroundImageKeys.map((key) => {
        const source = bundledBoardArtSource(key, colorScheme);
        return source === null ? null : (
          <Image key={key} source={source} style={StyleSheet.absoluteFill} contentFit="contain" accessible={false} />
        );
      })}
    </InspectionArt>
  );
}

function InspectionArt({
  boardName,
  frames,
  name,
  width,
  height,
  holds,
  mirrored,
  children,
  labels,
}: {
  boardName: BoardName;
  frames: string;
  name: string;
  width: number;
  height: number;
  holds: LitHold[];
  mirrored?: boolean;
  children: ReactNode;
  labels?: ReactNode;
}) {
  const summary = useBoardAccessibilitySummary(boardName, frames);
  const stroke = Math.max(2, width / 240);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${name}. ${summary}`}
      style={[styles.art, mirrored && styles.mirror]}
    >
      {children}
      <Svg accessible={false} pointerEvents="none" width="100%" height="100%" viewBox={`0 0 ${width} ${height}`}>
        {holds.map(({ id, cx, cy, r, color, outline }) => {
          if (!outline) {
            return (
              <Circle
                key={id}
                cx={cx}
                cy={cy}
                r={r}
                fill={color}
                fillOpacity={0.2}
                stroke={color}
                strokeWidth={stroke}
              />
            );
          }
          const points: string[] = [];
          for (let index = 0; index < outline.length; index += 2) {
            points.push(`${cx + outline[index] * r},${cy + outline[index + 1] * r}`);
          }
          return (
            <Polygon
              key={id}
              points={points.join(' ')}
              fill={color}
              fillOpacity={0.2}
              stroke={color}
              strokeWidth={stroke}
            />
          );
        })}
      </Svg>
      {labels}
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { flex: 1, gap: spacing[3], padding: spacing[4] },
  art: { flex: 1, minHeight: 0 },
  mirror: { transform: [{ scaleX: -1 }] },
  expired: { flex: 1, justifyContent: 'center', gap: spacing[3], padding: spacing[4] },
});
