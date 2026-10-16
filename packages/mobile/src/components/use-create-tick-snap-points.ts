import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useWindowBottomInset } from '../hooks/use-window-bottom-inset';
import { CREATE_TICK_SNAP_POINTS } from './tick/tick-sheet-metrics';
import { SHEET_TOP_CHROME_PT, useSheetColumnStyle } from './use-sheet-column-style';

type Measurements = { key: string; generation: number; header?: number; body?: number; footer?: number };

/** Keep visible compact create-tick fields above its pinned composer when the large ceiling permits.
 * Both detents must survive every measurement update: Expo's index-sync effect
 * also watches detent count, and changing it can dismiss a presented modal. */
export function useCreateTickSnapPoints(locale: string | undefined, compact: boolean) {
  const { width, fontScale } = useWindowDimensions();
  const bottomInset = useWindowBottomInset();
  const medium = useSheetColumnStyle(CREATE_TICK_SNAP_POINTS);
  const large = useSheetColumnStyle(CREATE_TICK_SNAP_POINTS, { activeIndex: 1 });
  const key = `${width}:${fontScale}:${locale ?? ''}`;
  // Equality alone cannot identify a late native callback after A→B→A.
  // Advance generations on every transition, even if the key/mode returns.
  const layoutContextRef = useRef({ key, compact, geometryGeneration: 0, compactGeneration: 0 });
  if (layoutContextRef.current.key !== key) {
    layoutContextRef.current.key = key;
    layoutContextRef.current.geometryGeneration += 1;
  }
  if (layoutContextRef.current.compact !== compact) {
    layoutContextRef.current.compact = compact;
    layoutContextRef.current.compactGeneration += 1;
  }
  const { geometryGeneration, compactGeneration } = layoutContextRef.current;
  const [measurements, setMeasurements] = useState<Measurements>({ key, generation: geometryGeneration });
  const record = useCallback(
    (field: 'header' | 'body' | 'footer', height: number) => {
      if (layoutContextRef.current.geometryGeneration !== geometryGeneration || !Number.isFinite(height) || height <= 0)
        return;
      const rounded = Math.ceil(height);
      setMeasurements((previous) => {
        const current = previous.generation === geometryGeneration ? previous : { key, generation: geometryGeneration };
        return current[field] === rounded ? current : { ...current, [field]: rounded };
      });
    },
    [key, geometryGeneration],
  );
  const onHeaderLayout = useCallback((height: number) => record('header', height), [record]);
  const onBodyLayout = useCallback(
    (height: number) => {
      // Expanded-only date/time must not become part of the compact height, even
      // when an async native measure arrives after a collapse/expand round trip.
      if (compact && layoutContextRef.current.compactGeneration === compactGeneration) record('body', height);
    },
    [compact, compactGeneration, record],
  );
  const onFooterLayout = useCallback(
    (measurement: { height: number; bottomInset: number }) => {
      // Ignore the expanded note. Remove the inset actually used in this layout;
      // the current resting window inset is added below, even with a keyboard up.
      // A native measure requested while compact may arrive after expansion.
      if (compact && layoutContextRef.current.compactGeneration === compactGeneration) {
        record('footer', measurement.height - measurement.bottomInset);
      }
    },
    [compact, compactGeneration, record],
  );
  const snapPoints = useMemo(() => {
    if (
      Platform.OS !== 'ios' ||
      measurements.key !== key ||
      measurements.generation !== geometryGeneration ||
      measurements.header == null ||
      measurements.body == null ||
      measurements.footer == null ||
      typeof medium.height !== 'number' ||
      typeof large.height !== 'number'
    )
      return CREATE_TICK_SNAP_POINTS;
    const required = Math.ceil(measurements.header + measurements.body + measurements.footer + bottomInset);
    if (required <= medium.height) return CREATE_TICK_SNAP_POINTS;
    return [
      Math.min(required + SHEET_TOP_CHROME_PT, large.height + SHEET_TOP_CHROME_PT - 1),
      CREATE_TICK_SNAP_POINTS[1],
    ];
  }, [measurements, key, geometryGeneration, medium.height, large.height, bottomInset]);
  return { snapPoints, onHeaderLayout, onBodyLayout, onFooterLayout };
}
