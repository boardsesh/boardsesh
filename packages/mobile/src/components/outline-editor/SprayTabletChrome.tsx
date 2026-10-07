import React, { type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { Button } from '../Button';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import type { SprayEditorCounts } from './spray-hold-editor-reducer';
import { SprayCountCapsule } from './SprayCountCapsule';
import { SPRAY_BAR_GUTTER, SPRAY_BAR_HEIGHT } from './spray-photo-frame';
import {
  sprayTabletPlacement,
  SPRAY_CLUSTER_SIDE_WIDTH,
  SPRAY_INSPECTOR_WIDTH,
  SPRAY_RAIL_MARGIN,
  SPRAY_RAIL_WIDTH,
  SPRAY_TABLET_CONTENT_MAX_WIDTH,
  type SprayRailSide,
} from './spray-tablet-layout';

type SprayTabletChromeProps = {
  railSide: SprayRailSide;
  landscape: boolean;
  insets: EdgeInsets;
  /** The tool rail. It docks and drags itself. */
  rail: ReactNode;
  /** The wall-wide menu, beside the rail while it is open. */
  menu: ReactNode;
  /** The picked hold's card, or null. */
  inspector: ReactNode;
  /** The undo toast and the Corners Finish chip, stacked above the cluster. */
  dock: ReactNode;
  counts: SprayEditorCounts;
  showMaybes: boolean;
  celebrating: boolean;
  locked: boolean;
  primaryLabel: string;
  primaryLoading: boolean;
  primaryDisabled: boolean;
  onPrimary: () => void;
};

/**
 * The iPad editor's chrome, laid out round the photo it floats over: the tool
 * rail down one side, and on the other side everything the hand on the wall
 * reaches for — the picked hold's inspector, the undo toast — with the counts
 * and the primary button in a cluster along the bottom. `sprayTabletPlacement`
 * is the table this follows; this component only turns it into positions.
 *
 * It takes the pieces as slots rather than their props, so the editor screen
 * keeps one set of handlers for both layouts and this file stays about where
 * things go.
 */
export function SprayTabletChrome({
  railSide,
  landscape,
  insets,
  rail,
  menu,
  inspector,
  dock,
  counts,
  showMaybes,
  celebrating,
  locked,
  primaryLabel,
  primaryLoading,
  primaryDisabled,
  onPrimary,
}: SprayTabletChromeProps) {
  const placement = sprayTabletPlacement({ railSide, landscape });
  const oppositeOffset = edgeOffset(placement.oppositeEdge, insets);
  const clusterBottom = insets.bottom + SPRAY_BAR_GUTTER;
  const aboveCluster = clusterBottom + SPRAY_BAR_HEIGHT + spacing[2];
  const columnAlign: ViewStyle = { alignItems: placement.oppositeEdge === 'right' ? 'flex-end' : 'flex-start' };

  const cluster = (
    <View style={styles.clusterRow}>
      <SprayCountCapsule counts={counts} showMaybes={showMaybes} celebrating={celebrating} locked={locked} />
      <Button
        title={primaryLabel}
        variant="filled"
        size="large"
        onPress={onPrimary}
        loading={primaryLoading}
        disabled={primaryDisabled}
        minHeight={SPRAY_BAR_HEIGHT}
      />
    </View>
  );

  return (
    <>
      {rail}

      {menu ? (
        <View
          pointerEvents="box-none"
          style={[styles.menuTrack, edgeOffset(placement.railEdge, insets, SPRAY_RAIL_WIDTH + spacing[2])]}
        >
          {menu}
        </View>
      ) : null}

      {inspector && placement.inspector === 'top' ? (
        <View pointerEvents="box-none" style={[styles.column, columnAlign, oppositeOffset, styles.topColumn]}>
          {inspector}
        </View>
      ) : null}

      {/* One column on the side away from the rail, just above the cluster: the
          toast on top, then (portrait) the inspector, so they stack rather than
          overlap. */}
      <View pointerEvents="box-none" style={[styles.column, columnAlign, oppositeOffset, { bottom: aboveCluster }]}>
        {dock}
        {inspector && placement.inspector === 'bottom' ? inspector : null}
      </View>

      {placement.cluster === 'side' ? (
        <View pointerEvents="box-none" style={[styles.sideCluster, oppositeOffset, { bottom: clusterBottom }]}>
          {cluster}
        </View>
      ) : (
        <View pointerEvents="box-none" style={[styles.centreClusterTrack, { bottom: clusterBottom }]}>
          <View style={styles.centreCluster}>{cluster}</View>
        </View>
      )}
    </>
  );
}

/** Distance from one screen edge, outside the safe area: the rail's margin, plus `extra`. */
function edgeOffset(edge: 'left' | 'right', insets: EdgeInsets, extra = 0): ViewStyle {
  const offset = (edge === 'left' ? insets.left : insets.right) + SPRAY_RAIL_MARGIN + extra;
  return edge === 'left' ? { left: offset } : { right: offset };
}

const styles = StyleSheet.create({
  menuTrack: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  column: {
    position: 'absolute',
    width: SPRAY_INSPECTOR_WIDTH,
    gap: spacing[2],
  },
  // Below the top row, where the reset-zoom control sits.
  topColumn: {
    top: spacing[2] * 2 + glassSize.capsule,
  },
  clusterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  sideCluster: {
    position: 'absolute',
    width: SPRAY_CLUSTER_SIDE_WIDTH,
  },
  centreClusterTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  centreCluster: {
    width: '100%',
    maxWidth: SPRAY_TABLET_CONTENT_MAX_WIDTH,
  },
});
