import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { PointAnchoredPopover } from '../navigation/PointAnchoredPopover';
import type { WindowAnchorPoint } from '../navigation/AnchoredPopover.types';
import { ClimbPreviewCard } from '../ClimbPreviewCard';
import { SheetTopBar } from '../SheetTopBar';
import { InlinePlaylistPicker } from './InlinePlaylistPicker';

type AddToPlaylistPopoverProps = {
  visible: boolean;
  climb: Climb;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  anchorPoint: WindowAnchorPoint;
  onClose: () => void;
};

/** A list-row selector uses its real source position, even inside UIKit panes. */
export function AddToPlaylistPopover({ anchorPoint, ...props }: AddToPlaylistPopoverProps) {
  const { t } = useTranslation('climbs');
  const { height: windowHeight } = useWindowDimensions();
  const rootRef = useRef<View>(null);
  const sourceRef = useRef(anchorPoint);
  sourceRef.current = anchorPoint;
  const measurementRevision = useRef(0);
  const [localPoint, setLocalPoint] = useState<WindowAnchorPoint | null>(null);
  const measureRoot = useCallback(() => {
    const source = sourceRef.current;
    const revision = ++measurementRevision.current;
    rootRef.current?.measureInWindow((rootX, rootY) => {
      if (
        revision !== measurementRevision.current ||
        source !== sourceRef.current ||
        !Number.isFinite(rootX) ||
        !Number.isFinite(rootY)
      )
        return;
      setLocalPoint({ x: source.x - rootX, y: source.y - rootY });
    });
  }, []);
  useLayoutEffect(() => {
    setLocalPoint(null);
    measureRoot();
    return () => {
      measurementRevision.current += 1;
    };
  }, [anchorPoint, measureRoot]);

  return (
    <View
      ref={rootRef}
      collapsable={false}
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
      onLayout={measureRoot}
    >
      <PointAnchoredPopover
        point={localPoint ?? { x: 0, y: 0 }}
        visible={props.visible && localPoint !== null}
        onClose={props.onClose}
        width={400}
        content={
          <View>
            <SheetTopBar
              title={t('actions.playlist.popover.title')}
              leading={{ kind: 'close', onPress: props.onClose }}
            />
            <ClimbPreviewCard
              climb={props.climb}
              boardName={props.boardName}
              layoutId={props.layoutId}
              sizeId={props.sizeId}
              setIds={props.setIds}
              angle={props.angle}
            />
            <InlinePlaylistPicker
              key={`${props.boardName}:${props.layoutId}:${props.climb.uuid}:${props.angle}`}
              active={props.visible}
              climb={props.climb}
              angle={props.angle}
              boardName={props.boardName}
              layoutId={props.layoutId}
              TextInputComponent={TextInput}
              maxHeight={Math.max(200, windowHeight - 300)}
            />
          </View>
        }
      />
    </View>
  );
}
