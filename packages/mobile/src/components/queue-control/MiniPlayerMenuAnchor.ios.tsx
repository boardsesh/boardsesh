import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View, type ViewInstance } from 'react-native';
import { Portal } from 'react-native-paper';
import { useSegments } from 'expo-router';
import { AppMenu } from '../AppMenu';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';
import { isAccessoryHiddenRoute, isAccessorySurfaceRoute, isPlayerRoute, isTabsRoute } from '../../lib/route-segments';
import { useVerticalTabBar } from '../../hooks/use-vertical-tab-bar';
import {
  resolveAccessoryMenuAnchor,
  useAccessoryPresentation,
  type AccessoryPresentation,
  type WindowRect,
} from './accessory-presentation';
import type { MiniPlayerMenuAnchorProps } from './MiniPlayerMenuAnchor.types';

type AnchorMeasurement = {
  presentation: AccessoryPresentation;
  credentialGeneration: number;
  actions: MiniPlayerMenuAnchorProps['actions'];
  anchorSize: number;
  rect: WindowRect;
};

/**
 * UIKit's accessory hides its whole glass group while a descendant's menu opens.
 * Keep the slot in place, but host only the native menu at the app's Paper root.
 * Native settlement is authoritative: both regular/inline source trees stay mounted.
 */
export function MiniPlayerMenuAnchor(props: MiniPlayerMenuAnchorProps) {
  const sourceRef = useRef<ViewInstance | null>(null);
  const rootRef = useRef<ViewInstance | null>(null);
  const requestRevision = useRef(0);
  const { store, presentation } = useAccessoryPresentation();
  const credentialGeneration = useSyncExternalStore(subscribeToCredentialChanges, getCredentialGeneration);
  const owningCredentialGeneration = useRef(credentialGeneration).current;
  const segments = useSegments();
  const verticalTabBar = useVerticalTabBar();
  // The Duo rail keeps its accessory under pushed filters; hiding it would collapse the rail.
  const railFilter = verticalTabBar && isTabsRoute(segments) && isAccessoryHiddenRoute(segments);
  const onSurface =
    (isAccessorySurfaceRoute(segments) || railFilter) &&
    !isPlayerRoute(segments) &&
    (!isAccessoryHiddenRoute(segments) || verticalTabBar) &&
    credentialGeneration === owningCredentialGeneration;
  const [measurement, setMeasurement] = useState<AnchorMeasurement | null>(null);
  const current = useRef({
    presentation,
    credentialGeneration,
    onSurface,
    actions: props.actions,
    anchorSize: props.anchorSize,
  });
  current.current = {
    presentation,
    credentialGeneration,
    onSurface,
    actions: props.actions,
    anchorSize: props.anchorSize,
  };

  const measureAnchor = useCallback(() => {
    const request = ++requestRevision.current;
    // A position-only source/root layout can change without a native presentation
    // revision. Withdraw the old hit target until this measurement completes.
    setMeasurement(null);
    if (!presentation || !onSurface || !store || !sourceRef.current || !rootRef.current) return;
    const isCurrent = () =>
      request === requestRevision.current &&
      current.current.onSurface &&
      current.current.presentation === presentation &&
      store.getSnapshot() === presentation &&
      getCredentialGeneration() === credentialGeneration &&
      current.current.actions === props.actions &&
      current.current.anchorSize === props.anchorSize;
    sourceRef.current.measureInWindow((sourceX, sourceY, sourceWidth, sourceHeight) => {
      if (!isCurrent()) return;
      rootRef.current?.measureInWindow((rootX, rootY, rootWidth, rootHeight) => {
        if (!isCurrent()) return;
        const rect = resolveAccessoryMenuAnchor(
          { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
          { x: rootX, y: rootY, width: rootWidth, height: rootHeight },
          presentation.frame,
        );
        setMeasurement(
          rect
            ? { presentation, credentialGeneration, actions: props.actions, anchorSize: props.anchorSize, rect }
            : null,
        );
      });
    });
  }, [presentation, credentialGeneration, onSurface, store, props.actions, props.anchorSize]);

  useLayoutEffect(() => {
    measureAnchor();
    return () => {
      requestRevision.current++;
    };
  }, [measureAnchor, props.actions, props.anchorSize]);

  const measured =
    measurement?.presentation === presentation &&
    measurement?.credentialGeneration === credentialGeneration &&
    measurement.actions === props.actions &&
    measurement.anchorSize === props.anchorSize
      ? measurement.rect
      : null;
  return (
    <>
      <View
        ref={sourceRef}
        collapsable={false}
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onLayout={measureAnchor}
        style={{ width: props.anchorSize, height: props.anchorSize }}
      />
      {onSurface && presentation ? (
        <Portal>
          <View
            ref={rootRef}
            collapsable={false}
            accessible={false}
            pointerEvents="box-none"
            style={StyleSheet.absoluteFill}
            onLayout={measureAnchor}
          >
            {measured ? (
              <View
                pointerEvents="box-none"
                style={{
                  position: 'absolute',
                  left: measured.x,
                  top: measured.y,
                  width: measured.width,
                  height: measured.height,
                }}
              >
                <AppMenu {...props} />
              </View>
            ) : null}
          </View>
        </Portal>
      ) : null}
    </>
  );
}
