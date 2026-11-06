import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { Column, Icon, IconButton, ModalBottomSheet, Row, Text, TextButton } from '@expo/ui/jetpack-compose';
import type { ModalBottomSheetRef } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, height, padding, weight } from '@expo/ui/jetpack-compose/modifiers';
import { ComposeHost } from './ComposeHost.android';
import { ClimbFilterForm, type ClimbFilterFormHandle } from './ClimbFilterForm.android';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import type { ClimbFilterSurfaceHandle, ClimbFilterSurfaceProps } from './ClimbFilterSurface.types';

const CLOSE_ICON = require('../../assets/material-icons/close.xml');

/** Native sheet and scroll owners stay in one composition, without an RN bridge. */
export const ClimbFilterSurface = forwardRef<ClimbFilterSurfaceHandle, ClimbFilterSurfaceProps>(
  function ClimbFilterSurface(
    {
      model,
      title,
      subtitle,
      closeLabel,
      resetLabel,
      resetDisabled,
      onClosePress,
      onReset,
      onChange,
      initialScrollPosition,
    },
    ref,
  ) {
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const { systemColors, brandColors, sheetSurface } = useTheme();
    const nativeRef = useRef<ModalBottomSheetRef>(null);
    const formRef = useRef<ClimbFilterFormHandle>(null);
    const [presentation, setPresentation] = useState<{ generation: number; expanded: boolean } | null>(null);
    const generationRef = useRef(0);
    const openRef = useRef(false);
    const mountedRef = useRef(true);
    const closingRef = useRef(false);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        generationRef.current += 1;
      };
    }, []);

    const finishClose = useCallback((generation: number) => {
      if (!mountedRef.current || generation !== generationRef.current || !openRef.current) return;
      openRef.current = false;
      closingRef.current = false;
      setPresentation(null);
      onChangeRef.current(-1);
    }, []);
    const dismiss = useCallback(() => {
      if (!openRef.current || closingRef.current) return;
      closingRef.current = true;
      const generation = generationRef.current;
      const nativeHandle = nativeRef.current;
      // Native handlers can throw before returning a promise, or reject during teardown.
      void Promise.resolve()
        .then(() => nativeHandle?.hide())
        .catch((error: unknown) => {
          if (__DEV__) console.warn('[filters] native hide unavailable', error);
        })
        .then(() => finishClose(generation));
    }, [finishClose]);
    const snapToIndex = useCallback(
      (index: number) => {
        if (index < 0) {
          dismiss();
          return;
        }
        const expanded = index > 0;
        if (!openRef.current || closingRef.current) {
          const generation = ++generationRef.current;
          openRef.current = true;
          closingRef.current = false;
          setPresentation({ generation, expanded });
        } else {
          const nativeHandle = nativeRef.current;
          const generation = generationRef.current;
          void Promise.resolve()
            .then(() => {
              if (!mountedRef.current || generation !== generationRef.current || !openRef.current || closingRef.current)
                return;
              return expanded ? nativeHandle?.expand() : nativeHandle?.partialExpand();
            })
            .catch((error: unknown) => {
              if (__DEV__) console.warn('[filters] native snap unavailable', error);
            });
        }
        onChangeRef.current(expanded ? 1 : 0);
      },
      [dismiss],
    );
    useImperativeHandle(
      ref,
      () => ({
        snapToIndex,
        snapToPosition: (position) => snapToIndex(typeof position === 'string' && parseFloat(position) <= 50 ? 0 : 1),
        expand: () => snapToIndex(1),
        collapse: () => snapToIndex(0),
        present: () => snapToIndex(0),
        dismiss,
        close: dismiss,
        forceClose: dismiss,
        captureScrollPosition: async () => formRef.current?.captureScrollPosition() ?? { offsetDp: 0 },
      }),
      [dismiss, snapToIndex],
    );
    if (!presentation) return null;
    return (
      <ComposeHost style={[styles.host, { width: windowWidth }]}>
        <ModalBottomSheet
          key={presentation.generation}
          ref={nativeRef}
          skipPartiallyExpanded={false}
          initialFullyExpanded={presentation.expanded}
          sheetGesturesEnabled
          showDragHandle
          onDismissRequest={() => finishClose(presentation.generation)}
          containerColor={sheetSurface}
          contentColor={systemColors.label}
          properties={{ shouldDismissOnBackPress: true, shouldDismissOnClickOutside: true }}
        >
          {/* A full-window content bound supplies both Material partial and expanded anchors. */}
          <Column modifiers={[fillMaxWidth(), height(windowHeight * 0.9)]}>
            <Row
              modifiers={[fillMaxWidth(), padding(spacing[2], 0, spacing[2], spacing[2])]}
              verticalAlignment="center"
            >
              <IconButton onClick={onClosePress}>
                <Icon source={CLOSE_ICON} contentDescription={closeLabel} size={24} />
              </IconButton>
              <Column modifiers={[weight(1)]}>
                <Text style={{ typography: 'titleLarge' }} color={systemColors.label}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text style={{ typography: 'bodySmall' }} color={systemColors.secondaryLabel}>
                    {subtitle}
                  </Text>
                ) : null}
              </Column>
              <TextButton onClick={onReset} enabled={!resetDisabled} colors={{ contentColor: brandColors.primary }}>
                <Text>{resetLabel}</Text>
              </TextButton>
            </Row>
            <ClimbFilterForm
              ref={formRef}
              model={model}
              initialScrollPosition={initialScrollPosition}
              onNameFocus={() => {
                if (
                  !mountedRef.current ||
                  !openRef.current ||
                  closingRef.current ||
                  presentation.generation !== generationRef.current
                )
                  return;
                snapToIndex(1);
              }}
            />
          </Column>
        </ModalBottomSheet>
      </ComposeHost>
    );
  },
);
const styles = StyleSheet.create({ host: { position: 'absolute' } });
