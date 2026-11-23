import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { getOpeningInput } from '../lib/opening-input';
import {
  resolveSheetSurfaceBounds,
  resolveWebSheetPresentation,
  type OpeningInput,
  type SheetSurfaceSize,
} from '../lib/sheet-presentation-policy';

export type WebSheetViewport = { width: number; height: number; top: number; left: number; layoutWidth: number };

/** Follow the visible browser viewport when zoom or the software keyboard changes it. */
export function useWebSheetViewport(): WebSheetViewport {
  const { width, height } = useWindowDimensions();
  const readViewport = useCallback((): WebSheetViewport => {
    const viewport = typeof window === 'undefined' ? undefined : window.visualViewport;
    return {
      width: viewport?.width ?? width,
      height: viewport?.height ?? height,
      top: viewport?.offsetTop ?? 0,
      left: viewport?.offsetLeft ?? 0,
      layoutWidth: width,
    };
  }, [width, height]);
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const update = () => setViewport(readViewport());
    update();
    if (typeof window === 'undefined') return;
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener('resize', update);
    visualViewport?.addEventListener('scroll', update);
    return () => {
      visualViewport?.removeEventListener('resize', update);
      visualViewport?.removeEventListener('scroll', update);
    };
  }, [readViewport]);
  return viewport;
}

/** A presentation keeps its initiating input; only its available bounds remain live. */
export function useWebSheetPresentation(surfaceSize: SheetSurfaceSize = 'form') {
  const viewport = useWebSheetViewport();
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const [mode, setMode] = useState(() =>
    resolveWebSheetPresentation({ width: viewport.width, openingInput: getOpeningInput() }),
  );
  const modeRef = useRef(mode);
  const activeRef = useRef(false);
  const preparedInputRef = useRef<OpeningInput | undefined>(undefined);
  const preparePresentation = useCallback((input: OpeningInput) => {
    if (!activeRef.current) preparedInputRef.current = input;
  }, []);
  const capturePresentation = useCallback(() => {
    if (!activeRef.current) {
      const next = resolveWebSheetPresentation({
        width: viewportRef.current.width,
        openingInput: preparedInputRef.current ?? getOpeningInput(),
      });
      preparedInputRef.current = undefined;
      activeRef.current = true;
      modeRef.current = next;
      setMode(next);
    }
    return modeRef.current;
  }, []);
  const releasePresentation = useCallback(() => {
    activeRef.current = false;
    preparedInputRef.current = undefined;
  }, []);
  const bounds = useMemo(
    () => resolveSheetSurfaceBounds({ ...viewport, mode, surfaceSize }),
    [viewport, mode, surfaceSize],
  );
  return { mode, modeRef, bounds, viewport, preparePresentation, capturePresentation, releasePresentation };
}
