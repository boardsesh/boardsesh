import React, { useCallback, useEffect, useImperativeHandle, useRef, useState, type ComponentProps } from 'react';
import {
  AccessibilityInfo,
  Dimensions,
  FlatList,
  findNodeHandle,
  StyleSheet,
  View,
  useWindowDimensions,
  type ListRenderItem,
  type ViewInstance,
} from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import { useTranslation } from 'react-i18next';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';
import { hapticLight } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { cardCorners, overlays, shadows, spacing } from '../../theme/tokens';
import { springs, timing } from '../../theme/animations';
import { Icon } from '../Icon';
import { StaticPressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useAnnounceBodyFocus } from '../play-drawer/use-announce-body-focus';
import type { PlayDrawerMenuRow } from '../play-drawer/play-drawer-menu-rows';
import { FallbackClimbListRowMenu } from './ClimbListRowMenu.fallback';
import type { ClimbListRowMenuProps } from './ClimbListRowMenu.types';
import { getLiftedRowMenuLayout, type MenuAnchorRect } from './lifted-row-menu-layout';

export type { ClimbListRowMenuHandle } from './ClimbListRowMenu.types';

type MenuSnapshot = Pick<ClimbListRowMenuProps, 'rows' | 'menuKey' | 'preview' | 'title' | 'previewOverlayColor'> & {
  anchor: MenuAnchorRect;
  generation: number;
  viewport: ReturnType<typeof Dimensions.get>;
};

// A second row opening retires the first, including an outstanding measurement.
let retireActiveMenu: (() => void) | undefined;
const PREVIEW_PADDING = 8;
const menuRowKey = (row: PlayDrawerMenuRow) => row.id;

export function ClimbListRowMenu(props: ClimbListRowMenuProps) {
  return props.enabled ? <LiftedClimbListRowMenu {...props} /> : <FallbackClimbListRowMenu {...props} />;
}

function LiftedClimbListRowMenu(props: ClimbListRowMenuProps) {
  const { systemColors } = useTheme();
  const sourceRef = useRef<ViewInstance | null>(null);
  const current = useRef(props);
  current.current = props;
  const revision = useRef(0);
  const mounted = useRef(true);
  const pending = useRef<{ snapshot: MenuSnapshot; revision: number; run?: () => void; restoreFocus: boolean } | null>(
    null,
  );
  const [snapshot, setSnapshot] = useState<MenuSnapshot | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const retire = useCallback(() => {
    revision.current++;
    pending.current = null;
    setSnapshot(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
      pending.current = null;
      if (retireActiveMenu === retire) retireActiveMenu = undefined;
    };
  }, [retire]);
  useEffect(() => {
    retire();
  }, [props.menuKey, retire]);

  const open = useCallback(() => {
    if (snapshotRef.current || current.current.rows.length === 0) return;
    retireActiveMenu?.();
    retireActiveMenu = retire;
    const request = ++revision.current;
    const { rows, menuKey, preview, title, previewOverlayColor } = current.current;
    const generation = getCredentialGeneration();
    const viewport = Dimensions.get('window');
    current.current.onBeforeOpen?.();
    // reset() settles a partially swiped row on the next UI frame. Both
    // triggers measure the same resting body after that reset.
    requestAnimationFrame(() => {
      if (!mounted.current || revision.current !== request) return;
      sourceRef.current?.measureInWindow((x, y, width, height) => {
        if (
          !mounted.current ||
          revision.current !== request ||
          current.current.menuKey !== menuKey ||
          generation !== getCredentialGeneration() ||
          ![x, y, width, height].every(Number.isFinite) ||
          width <= 0 ||
          height <= 0
        )
          return;
        hapticLight();
        setSnapshot({
          rows,
          menuKey,
          preview,
          title,
          previewOverlayColor,
          generation,
          viewport,
          anchor: { x, y, width, height },
        });
      });
    });
  }, [retire]);
  useImperativeHandle(props.ref, () => ({ open }), [open]);

  // This effect runs after React has removed FullWindowOverlay. Presenters can
  // now claim the native window, rather than racing a still-mounted menu.
  useEffect(() => {
    if (snapshot || !pending.current) return;
    const command = pending.current;
    pending.current = null;
    const frame = requestAnimationFrame(() => {
      if (
        !mounted.current ||
        command.revision !== revision.current ||
        command.snapshot.menuKey !== current.current.menuKey ||
        command.snapshot.generation !== getCredentialGeneration()
      )
        return;
      if (retireActiveMenu === retire) retireActiveMenu = undefined;
      if (command.run) command.run();
      else if (command.restoreFocus) {
        const handle = findNodeHandle(current.current.focusRef.current);
        if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [snapshot, retire]);

  const finish = useCallback((expected: MenuSnapshot, selected?: PlayDrawerMenuRow) => {
    const active = snapshotRef.current;
    if (!active || active !== expected) return;
    pending.current = { snapshot: active, revision: revision.current, run: selected?.run, restoreFocus: !selected };
    setSnapshot(null);
  }, []);

  const active = snapshot?.menuKey === props.menuKey ? snapshot : null;
  return (
    <>
      <View ref={sourceRef} collapsable={false} style={props.bodyStyle}>
        {active ? <View style={{ width: '100%', height: active.anchor.height }} /> : props.children}
      </View>
      {props.showMoreButton && props.rows.length > 0 ? (
        <View testID="climb-row-more-button" style={props.moreButtonStyle}>
          <StaticPressableSurface
            onPress={open}
            accessibilityLabel={props.accessibilityLabel}
            style={styles.moreButton}
          >
            <Icon name="more" size={20} color={systemColors.label} />
          </StaticPressableSurface>
        </View>
      ) : null}
      {active ? <LiftedRowMenu snapshot={active} finish={finish} retire={retire} /> : null}
    </>
  );
}

const LiftedMenuAction = React.memo(function LiftedMenuAction({
  row,
  select,
}: {
  row: PlayDrawerMenuRow;
  select: (row: PlayDrawerMenuRow) => void;
}) {
  const { systemColors } = useTheme();
  const color = row.destructive ? systemColors.error : systemColors.label;
  return (
    <View>
      {row.dividerBefore ? <View style={[styles.groupDivider, { backgroundColor: systemColors.separator }]} /> : null}
      <StaticPressableSurface
        testID={`climb-row-menu-action-${row.id}`}
        disabled={row.disabled}
        accessibilityLabel={row.label}
        accessibilityState={{ selected: row.selected, disabled: row.disabled }}
        onPress={() => select(row)}
        style={({ pressed }) => [
          styles.action,
          { backgroundColor: pressed ? systemColors.tertiaryBackground : 'transparent' },
        ]}
      >
        <Text color={color} style={styles.actionLabel}>
          {row.label}
        </Text>
        {row.selected ? (
          <SymbolView name="checkmark" size={19} tintColor={color} />
        ) : row.systemIcon ? (
          <SymbolView name={row.systemIcon as ComponentProps<typeof SymbolView>['name']} size={21} tintColor={color} />
        ) : null}
      </StaticPressableSurface>
    </View>
  );
});

function LiftedRowMenu({
  snapshot,
  finish,
  retire,
}: {
  snapshot: MenuSnapshot;
  finish: (expected: MenuSnapshot, selected?: PlayDrawerMenuRow) => void;
  retire: () => void;
}) {
  const { t } = useTranslation();
  const { systemColors } = useTheme();
  const viewport = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const progress = useSharedValue(0);
  const closing = useRef(false);
  const selectedRow = useRef<PlayDrawerMenuRow | undefined>(undefined);
  const headerRef = useRef<ViewInstance | null>(null);
  const [menuHeight, setMenuHeight] = useState(() =>
    snapshot.rows.reduce(
      (height, row) => height + Math.max(44, 24 * snapshot.viewport.fontScale + 20) + (row.dividerBefore ? 8 : 0),
      0,
    ),
  );
  const anchor = {
    x: snapshot.anchor.x - PREVIEW_PADDING,
    y: snapshot.anchor.y - PREVIEW_PADDING,
    width: snapshot.anchor.width + PREVIEW_PADDING * 2,
    height: snapshot.anchor.height + PREVIEW_PADDING * 2,
  };
  const layout = getLiftedRowMenuLayout({ anchor, viewport, insets, menuHeight });
  useAnnounceBodyFocus(headerRef, true);
  useEffect(() => {
    progress.value = reduceMotion ? 1 : withSpring(1, springs.gentle);
  }, [progress, reduceMotion]);
  useEffect(() => {
    const unsubscribe = subscribeToCredentialChanges(retire);
    if (snapshot.generation !== getCredentialGeneration()) retire();
    return unsubscribe;
  }, [snapshot.generation, retire]);
  useEffect(() => {
    if (
      viewport.width !== snapshot.viewport.width ||
      viewport.height !== snapshot.viewport.height ||
      viewport.fontScale !== snapshot.viewport.fontScale
    )
      retire();
  }, [viewport.width, viewport.height, viewport.fontScale, snapshot, retire]);

  const completeDismiss = useCallback(() => finish(snapshot, selectedRow.current), [finish, snapshot]);
  const dismiss = useCallback(
    (row?: PlayDrawerMenuRow) => {
      if (closing.current || row?.disabled) return;
      closing.current = true;
      selectedRow.current = row;
      if (reduceMotion) completeDismiss();
      else
        progress.value = withTiming(0, { duration: timing.fast }, (complete) => {
          if (complete) runOnJS(completeDismiss)();
        });
    },
    [completeDismiss, progress, reduceMotion],
  );
  const cancel = useCallback(() => dismiss(), [dismiss]);
  const renderItem = useCallback<ListRenderItem<PlayDrawerMenuRow>>(
    ({ item }) => <LiftedMenuAction row={item} select={dismiss} />,
    [dismiss],
  );
  const measureMenu = useCallback((_width: number, height: number) => {
    if (Number.isFinite(height) && height > 0) setMenuHeight(height);
  }, []);
  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const previewStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: (anchor.x - layout.preview.left) * (1 - progress.value) },
      { translateY: (anchor.y - layout.preview.top) * (1 - progress.value) },
    ],
  }));
  const menuStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: 8 * (1 - progress.value) }],
  }));

  return (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal>
      <View style={StyleSheet.absoluteFill} accessibilityViewIsModal onAccessibilityEscape={cancel}>
        <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
          <StaticPressableSurface
            testID="climb-row-menu-backdrop"
            accessibilityLabel={t('common:ariaLabels.close')}
            onPress={cancel}
            style={[StyleSheet.absoluteFill, { backgroundColor: overlays.scrim }]}
          />
        </Animated.View>
        <Animated.View
          testID="climb-row-menu-preview"
          style={[styles.preview, layout.preview, { backgroundColor: systemColors.elevatedSurface }, previewStyle]}
        >
          {snapshot.previewOverlayColor ? (
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { backgroundColor: snapshot.previewOverlayColor }]}
            />
          ) : null}
          <View
            ref={headerRef}
            accessible
            accessibilityRole="header"
            accessibilityLabel={snapshot.title}
            style={styles.previewBody}
          >
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.previewBody}
            >
              {snapshot.preview}
            </View>
          </View>
        </Animated.View>
        <Animated.View
          style={[
            styles.menu,
            {
              left: layout.menu.left,
              top: layout.menu.top,
              width: layout.menu.width,
              maxHeight: layout.menu.maxHeight,
              backgroundColor: systemColors.elevatedSurface,
            },
            menuStyle,
          ]}
        >
          <FlatList
            testID="climb-row-menu-actions"
            data={snapshot.rows}
            renderItem={renderItem}
            keyExtractor={menuRowKey}
            onContentSizeChange={measureMenu}
            bounces={false}
            style={{ maxHeight: layout.menu.maxHeight }}
          />
        </Animated.View>
      </View>
    </FullWindowOverlay>
  );
}

const styles = StyleSheet.create({
  moreButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  preview: { position: 'absolute', ...cardCorners, ...shadows.xl, overflow: 'hidden', padding: PREVIEW_PADDING },
  previewBody: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  menu: { position: 'absolute', ...cardCorners, ...shadows.lg, overflow: 'hidden' },
  action: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  actionLabel: { flex: 1 },
  groupDivider: { height: 8 },
});
