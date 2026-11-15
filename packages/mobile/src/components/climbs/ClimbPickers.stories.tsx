import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { buildDefaultZone, toggleHoldFilterType } from '@boardsesh/climb-filters';
import type {
  HoldFilterMode,
  HoldFilterType,
  HoldsFilter,
  ZoneBoxInput,
  ZoneMatchMode,
} from '@boardsesh/shared-schema';
import type { StoryModule } from '../../dev/stories/types';
import { useStoryBoardFixture } from '../../dev/stories/story-board-fixture';
import { sprayStoryPhoto } from '../../dev/stories/StorySprayBoard';
import { useStoryBoardRenderStyle } from '../../dev/fixtures/board-render-style';
import { getCreateBoardHolds, type CreateBoardHolds } from '../../lib/create-board-holds';
import { useTheme } from '../../providers/theme-provider';
import { overlays } from '../../theme/tokens';
import { HoldFilterView } from './HoldFilterView';
import { ZoneFilterView } from './ZoneFilterView';
import { ZoneOverlay } from '../search/ZoneOverlay';
import type { FilterBoardTransformContext } from '../search/InteractiveFilterBoard';
import { SetterPickerList } from '../filter-sheet/SetterPickerList';
import { SheetTopBar } from '../SheetTopBar';

const noop = () => {};
const setters = [
  { setterUsername: 'alex', count: 42 },
  { setterUsername: 'morgan', count: 18 },
  { setterUsername: 'sam', count: 12 },
];
function PickerStory({
  kind,
  onReady,
  onError,
}: {
  kind: 'holds' | 'zone' | 'setters';
  onReady: () => void;
  onError: (error: unknown) => void;
}) {
  const fixture = useStoryBoardFixture();
  const STORY_BOARD = fixture.board;
  const geometry = useMemo<CreateBoardHolds>(() => {
    if (fixture.spray)
      return {
        boardWidth: fixture.spray.width,
        boardHeight: fixture.spray.height,
        edgeLeft: 0,
        edgeRight: fixture.spray.width,
        edgeTop: 0,
        edgeBottom: fixture.spray.height,
        holdTargets: fixture.spray.holds,
        family: 'spray',
      };
    const resolved = getCreateBoardHolds({ ...STORY_BOARD, setIds: STORY_BOARD.setIds.split(',').map(Number) });
    if (!resolved) throw new Error('Story board geometry missing');
    return resolved;
  }, [fixture, STORY_BOARD]);
  const dims = useMemo(
    () => ({
      boardWidth: geometry.boardWidth,
      boardHeight: geometry.boardHeight,
      edgeLeft: geometry.edgeLeft,
      edgeRight: geometry.edgeRight,
      edgeTop: geometry.edgeTop,
      edgeBottom: geometry.edgeBottom,
    }),
    [geometry],
  );
  const targets = geometry.holdTargets;
  const [photo, setPhoto] = useState<string>();
  useEffect(() => {
    if (!fixture.spray) return;
    let cancelled = false;
    const asset = sprayStoryPhoto(fixture.spray.photoId);
    void asset.downloadAsync().then(() => {
      if (!cancelled) setPhoto(asset.localUri ?? asset.uri);
    }, onError);
    return () => {
      cancelled = true;
    };
  }, [fixture, onError]);
  const renderStyle = useStoryBoardRenderStyle();
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [selectedType, setType] = useState<HoldFilterType>('HAND');
  const [applyMode, setMode] = useState<HoldFilterMode>('include');
  const [holdsFilter, setHolds] = useState<HoldsFilter>({});
  const [zoneBox, setZoneBox] = useState<ZoneBoxInput | null>(() => buildDefaultZone(dims));
  const [zoneMode, setZoneMode] = useState<ZoneMatchMode>('allHolds');
  const [selected, setSelected] = useState<string[]>(['alex']);
  const [query, setQuery] = useState('');
  const onHoldTap = useCallback(
    (id: number) =>
      setHolds((previous) => {
        const next = { ...previous };
        const entry = toggleHoldFilterType(previous[id] ?? {}, selectedType, applyMode);
        if (Object.keys(entry).length) next[id] = entry;
        else delete next[id];
        return next;
      }),
    [selectedType, applyMode],
  );
  const renderZone = useCallback(
    ({ pinchGesture, scaleSV, renderWidth, renderHeight }: FilterBoardTransformContext) =>
      zoneBox ? (
        <ZoneOverlay
          zoneBox={zoneBox}
          dims={dims}
          renderWidth={renderWidth}
          renderHeight={renderHeight}
          zoomScale={scaleSV}
          onCommit={setZoneBox}
          boardPinch={pinchGesture}
          brandColor={brandColors.primary}
          scrimColor={overlays.scrim}
          bodyLabel={t('mobile.zoneFilter.regionLabel')}
          bodyHint={t('mobile.zoneFilter.regionHint')}
          cornerLabels={{
            nw: t('mobile.zoneFilter.corner.topLeft'),
            ne: t('mobile.zoneFilter.corner.topRight'),
            sw: t('mobile.zoneFilter.corner.bottomLeft'),
            se: t('mobile.zoneFilter.corner.bottomRight'),
          }}
          cornerHint={t('mobile.zoneFilter.corner.hint')}
        />
      ) : null,
    [zoneBox, brandColors.primary, t, dims],
  );
  const onArtReadinessChange = useCallback(
    (state: string) => {
      if (state === 'ready') onReady();
      else if (state === 'failed') onError(new Error('Filter board art failed'));
    },
    [onReady, onError],
  );
  const width = Math.min(
    window.width - 32,
    ((window.height - insets.top - insets.bottom - 230) * dims.boardWidth) / dims.boardHeight,
  );
  const board = useMemo(
    () => ({
      ...STORY_BOARD,
      backgroundPhotoUrl: photo,
      renderStyleOverride: renderStyle,
      ...dims,
      holdTargets: targets,
      renderWidth: width,
      renderHeight: (width * dims.boardHeight) / dims.boardWidth,
      onArtReadinessChange,
    }),
    [width, onArtReadinessChange, renderStyle, STORY_BOARD, photo, dims, targets],
  );
  const title =
    kind === 'zone'
      ? t('mobile.zoneFilter.title')
      : kind === 'holds'
        ? t('mobile.holdFilter.title')
        : t('authors.title');
  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <SheetTopBar
        title={title}
        leading={{ kind: 'close', onPress: noop, accessibilityLabel: t('mobile.filter.close') }}
      />
      {kind === 'holds' ? (
        <HoldFilterView
          board={fixture.spray && !photo ? null : { ...board, holdsFilter, onHoldTap }}
          picker={{
            holdStyleOverride: renderStyle.holds,
            boardName: STORY_BOARD.boardName,
            selectedType,
            onSelectType: setType,
            applyMode,
            onApplyModeChange: setMode,
          }}
        />
      ) : kind === 'zone' ? (
        <ZoneFilterView
          board={{ ...board, renderInTransform: renderZone }}
          zoneActive={zoneBox !== null}
          zoneMode={zoneMode}
          modeOptions={[
            { key: 'allHolds', label: t('mobile.zoneFilter.allHolds') },
            { key: 'anyHold', label: t('mobile.zoneFilter.anyHold') },
          ]}
          onModeChange={setZoneMode}
          onClear={() => setZoneBox(null)}
          onEnable={() => setZoneBox(buildDefaultZone(dims))}
          bottomInset={insets.bottom}
        />
      ) : (
        <View style={{ flex: 1 }} onLayout={onReady}>
          <SetterPickerList
            setters={setters.filter((setter) => setter.setterUsername.includes(query.toLowerCase()))}
            isLoading={false}
            onSearchChange={setQuery}
            searchPlaceholder={t('authors.searchPlaceholder')}
            formatCount={(count) => t('authors.climbCount', { count })}
            selected={selected}
            onToggle={(name) =>
              setSelected((previous) =>
                previous.includes(name) ? previous.filter((item) => item !== name) : [...previous, name],
              )
            }
            onClearAll={() => setSelected([])}
            emptyLabel={t('authors.empty')}
          />
        </View>
      )}
    </View>
  );
}
const stories: StoryModule = {
  title: 'Screens / Climb pickers',
  stories: Object.fromEntries(
    (['holds', 'zone', 'setters'] as const).map((kind) => [
      kind,
      {
        name: kind,
        layout: 'fullscreen' as const,
        tab: 'climbs' as const,
        tabRoot: false,
        readiness: 'explicit' as const,
        render: ({ onReady, onError }) => <PickerStory kind={kind} onReady={onReady} onError={onError} />,
      },
    ]),
  ),
};
export default stories;
