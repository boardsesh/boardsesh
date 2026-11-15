import { createContext, useContext, useEffect, type ReactNode } from 'react';

export type ContentRenderObservation = { route: string; count: number };
export type ContentRenderObserver = (observation: ContentRenderObservation) => void;

const ContentRenderContext = createContext<ContentRenderObserver | null>(null);

/** Optional instrumentation supplied by the application composition root. */
export function ContentRenderObserverProvider({
  onContentRendered,
  children,
}: {
  onContentRendered: ContentRenderObserver;
  children: ReactNode;
}) {
  return <ContentRenderContext value={onContentRendered}>{children}</ContentRenderContext>;
}

/** Mount inside rendered content, so a query resolving alone never reports a paint. */
export function ContentRenderMarker({ route, count }: ContentRenderObservation): null {
  const observe = useContext(ContentRenderContext);
  useEffect(() => {
    observe?.({ route, count });
  }, [observe, route, count]);
  return null;
}
