import SpaApp from '../spa-app';

/**
 * Catch-all shell for the pure client-side-routed SPA experiment. Next only
 * ever renders this once per document load — `SpaApp` takes over routing via
 * the Web Navigation API from here on (see ../hooks/use-spa-router.ts).
 */
export default function SpaCatchAllPage() {
  return <SpaApp />;
}
