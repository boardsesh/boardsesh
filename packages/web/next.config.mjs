import { withSentryConfig } from '@sentry/nextjs';
import os from 'node:os';
import path from 'node:path';
// next.config.js

/** The backend origin behind NEXT_PUBLIC_WS_URL, pointed at one of its HTTP paths. */
function resolveBackendPathUrl(rawWsUrl, pathname, runtimeEnvironment = process.env.NODE_ENV) {
  const configuredWsUrl = rawWsUrl?.trim();
  if (!configuredWsUrl && runtimeEnvironment === 'production') {
    // Name the path: this helper serves several rewrites now, and an operator
    // reading the build failure should not have to guess which one asked.
    throw new Error(`NEXT_PUBLIC_WS_URL is required in production for the ${pathname} rewrite`);
  }
  let backendUrl;
  try {
    backendUrl = new URL(configuredWsUrl || 'ws://localhost:8080/graphql');
  } catch {
    throw new Error(`NEXT_PUBLIC_WS_URL is not a valid URL: ${JSON.stringify(configuredWsUrl)}`);
  }

  if (!['ws:', 'wss:', 'http:', 'https:'].includes(backendUrl.protocol)) {
    throw new Error('NEXT_PUBLIC_WS_URL must use ws, wss, http, or https');
  }

  backendUrl.protocol = backendUrl.protocol === 'wss:' || backendUrl.protocol === 'https:' ? 'https:' : 'http:';
  backendUrl.pathname = pathname;
  backendUrl.search = '';
  backendUrl.hash = '';
  return backendUrl.toString();
}

export function resolveBoardRenderBackendUrl(rawWsUrl, runtimeEnvironment = process.env.NODE_ENV) {
  return resolveBackendPathUrl(rawWsUrl, '/render/board', runtimeEnvironment);
}

export function resolveBoardGeometryBackendUrl(rawWsUrl, runtimeEnvironment = process.env.NODE_ENV) {
  return resolveBackendPathUrl(rawWsUrl, '/render/geometry', runtimeEnvironment);
}

export function resolveExpoWebDevOrigin(rawOrigin) {
  if (!rawOrigin) return null;

  let parsedOrigin;
  try {
    parsedOrigin = new URL(rawOrigin);
  } catch {
    // A scheme-less value (e.g. `//localhost:8081`) makes `new URL` throw a bare
    // "Invalid URL", which is opaque in a dev log. Fail with the actual value
    // and the expected shape so the misconfig is obvious.
    throw new Error(
      `BOARDSESH_EXPO_WEB_ORIGIN is not a valid URL: ${JSON.stringify(rawOrigin)}. ` +
        'Use a full origin with scheme, e.g. http://localhost:8081',
    );
  }

  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new Error('BOARDSESH_EXPO_WEB_ORIGIN must use http or https');
  }

  // This is a dev-only Metro proxy — the dev orchestrator only ever points it at
  // a loopback host (see scripts/lib/dev-server-origins.ts). Reject any other
  // host so a stray/misconfigured value can't turn the /app rewrite into an open
  // forward to an arbitrary origin.
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!LOOPBACK_HOSTS.has(parsedOrigin.hostname)) {
    throw new Error(
      `BOARDSESH_EXPO_WEB_ORIGIN must point at a loopback host (localhost/127.0.0.1/[::1]); got ${JSON.stringify(
        parsedOrigin.hostname,
      )}. It is a dev-only Metro proxy.`,
    );
  }

  return parsedOrigin.origin;
}

/**
 * Path-prefixed locales. `en-US` is served at the root with no prefix, so it is
 * absent here on purpose.
 *
 * `redirects()` runs before `middleware.ts`, and its sources are matched
 * literally: `/logbook` never matches `/es/logbook`. Every rule therefore ships
 * with its three locale twins (standing rule 4 of the web reposition), built by
 * `expandLocaleRedirects` below so a hand-written rule can't forget them.
 */
const PATH_LOCALE_PREFIXES = ['/es', '/fr', '/de'];

/**
 * Origin of the Expo-web app. Mirrors `DEFAULT_APP_ORIGIN` in
 * `@boardsesh/shared-schema/app-origins`, which cannot be imported here
 * (next.config.mjs loads outside the TS path aliases), so
 * `app/__tests__/next-config-redirects.test.ts` pins the literal against it.
 *
 * Exported separately from `APP_ORIGIN` on purpose: `NEXT_PUBLIC_APP_URL` is set
 * to `http://localhost:8081` for local Expo-web work (see `.env.local`), and a
 * test that pinned the env-resolved value would fail on a correct config the
 * moment that export is in the shell.
 */
export const DEFAULT_CONFIG_APP_ORIGIN = 'https://app.boardsesh.com';

export const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_CONFIG_APP_ORIGIN;

/**
 * Board-route siblings deleted by the web reposition (W-17, #4433), plus the
 * legacy library/profile paths that predate it.
 *
 * Same-origin destinations are `permanent: true` — they point at routes that
 * exist on this deploy and consolidating the signal is the point. The
 * cross-origin destinations are `permanent: false`: a browser caches a permanent
 * cross-origin redirect indefinitely, with no server-side hatch left if the SPA
 * route moves. They stay temporary until the app route is proven in prod.
 *
 * Order matters — Next matches these in array order, so a board-specific rule
 * has to come before the `/:board/…` catch-all that would otherwise swallow it.
 */
const BASE_REDIRECTS = [
  // Legacy library / profile paths.
  {
    source: '/my-library',
    destination: '/playlists',
    permanent: true,
  },
  {
    source: '/my-library/:path*',
    destination: '/playlists/:path*',
    permanent: true,
  },
  {
    source: '/:board/:layout/:size/:set/:angle/playlist/:uuid',
    destination: '/playlists/:uuid',
    permanent: true,
  },
  {
    source: '/crusher/:user_id',
    destination: '/profile/:user_id',
    permanent: true,
  },
  {
    source: '/logbook',
    destination: '/playlists',
    permanent: true,
  },

  // Climb creation moved to the app. A canonical numeric board URL hands its
  // board over intact: these are exactly the params the app's create screen
  // reads (`packages/mobile/app/(tabs)/climbs/create.tsx`), and it falls back to
  // the signed-in user's active board for any it doesn't get.
  {
    source: '/:board/:layout(\\d+)/:size(\\d+)/:set([\\d,]+)/:angle(\\d+)/create',
    destination: `${APP_ORIGIN}/climbs/create?boardName=:board&layoutId=:layout&sizeId=:size&setIds=:set&angle=:angle`,
    permanent: false,
  },
  // The slug forms hand over bare. The app parses layoutId/sizeId with
  // `Number()`, so forwarding `original`/`12x12-square` would seed the editor
  // with NaN — worse than its active-board fallback — and resolving a slug needs
  // a DB lookup a static redirect cannot do. Recorded on #4433.
  {
    source: '/:board/:layout/:size/:set/:angle/create',
    destination: `${APP_ORIGIN}/climbs/create`,
    permanent: false,
  },
  {
    source: '/b/:board_slug/:angle/create',
    destination: `${APP_ORIGIN}/climbs/create`,
    permanent: false,
  },

  // The MoonBoard bulk importer stays on Next, re-homed to a board-agnostic
  // route. Layout, hold sets and angle ride along so a bookmarked import URL
  // opens the wall it named; anything unresolvable lands on the picker.
  {
    source: '/moonboard/:layout/:size/:set/:angle/import',
    destination: '/moonboard-import?layout=:layout&sets=:set&angle=:angle',
    permanent: true,
  },
  // Bulk import is MoonBoard-only — the deleted page sent a Kilter or Tension
  // import URL to that board's own list instead of rendering the importer. This
  // rule keeps that, and it has to exist: `MOONBOARD_LAYOUTS` ids run 1–7 and
  // collide with Aurora layout ids, so without it `/kilter/1/…/import` would
  // resolve to MoonBoard 2010 and render the importer for the wrong board.
  {
    source: '/:board/:layout/:size/:set/:angle/import',
    destination: '/:board/:layout/:size/:set/:angle/list',
    permanent: true,
  },
  // The `/b` tree can't make that split: the slug names a board row, and only a
  // DB lookup says whether it's a MoonBoard. It goes to the importer because
  // that is the only reason to open `/import` at all; a non-MoonBoard slug lands
  // on the picker, which is a noindex utility page with a way back.
  {
    source: '/b/:board_slug/:angle/import',
    destination: '/moonboard-import?angle=:angle',
    permanent: true,
  },

  // Liked climbs live in the app; the board's own front door is the closest
  // surviving surface on www.
  {
    source: '/:board/:layout/:size/:set/:angle/liked',
    destination: '/:board/:layout/:size/:set/:angle/list',
    permanent: true,
  },
  {
    source: '/b/:board_slug/:angle/liked',
    destination: '/b/:board_slug/:angle/list',
    permanent: true,
  },

  // The board logbook rendered the playlists library — the same destination the
  // top-level `/logbook` rule above already uses.
  {
    source: '/:board/:layout/:size/:set/:angle/logbook',
    destination: '/playlists',
    permanent: true,
  },
  {
    source: '/b/:board_slug/:angle/logbook',
    destination: '/playlists',
    permanent: true,
  },

  // Board-scoped playlists consolidate onto the top-level library — the plural
  // twin of the singular `/playlist/:uuid` rule above.
  {
    source: '/:board/:layout/:size/:set/:angle/playlists',
    destination: '/playlists',
    permanent: true,
  },
  {
    source: '/:board/:layout/:size/:set/:angle/playlists/:uuid',
    destination: '/playlists/:uuid',
    permanent: true,
  },
  {
    source: '/b/:board_slug/:angle/playlists',
    destination: '/playlists',
    permanent: true,
  },
  {
    source: '/b/:board_slug/:angle/playlists/:uuid',
    destination: '/playlists/:uuid',
    permanent: true,
  },

  // W-19 (#4437): the private web surfaces. Your feed, dashboard and stats live
  // in the app now. Cross-origin, so `permanent: false` — a browser caches a
  // permanent cross-origin redirect indefinitely and there is no server-side
  // hatch if the SPA route moves. `/you/:path*` swallows the old `/you/logbook`
  // rule, which pointed at a page this PR deletes.
  {
    source: '/you',
    destination: `${APP_ORIGIN}/profile`,
    permanent: false,
  },
  {
    source: '/you/:path*',
    destination: `${APP_ORIGIN}/profile`,
    permanent: false,
  },
  {
    source: '/feed',
    destination: `${APP_ORIGIN}/home`,
    permanent: false,
  },
  // W-20b (#4439): the notification centre. The Home tab's bell is the app's
  // primary entry point, and backing out of it lands on the feed — the same
  // place `/feed` above already sends people, so the hand-off is one story
  // rather than two. Cross-origin, so `permanent: false`.
  {
    source: '/notifications',
    destination: `${APP_ORIGIN}/home/notifications`,
    permanent: false,
  },
  // `/discover` lost its page in W-13a and this PR removes the orphan layout,
  // but the URL still took 435 views from 117 people over the last 90 days.
  // The app carries the surface under the same path, which is already how
  // `playlists/library-page-content.tsx` hands off to it.
  {
    source: '/discover',
    destination: `${APP_ORIGIN}/discover`,
    permanent: false,
  },
  // The Instagram beta importer had zero users over two consecutive 90-day
  // windows and no app twin. Same-origin, so `permanent: true`.
  {
    source: '/import-beta',
    destination: '/',
    permanent: true,
  },
];

/**
 * One rule per locale: the base (unprefixed, `en-US`) rule plus its `/es`,
 * `/fr` and `/de` twins. Same-origin destinations keep the reader in their
 * locale; the app origin has no locale routing, so its twins keep the same
 * target — the accepted regression `buildAppHandoffUrl` already records.
 */
export function expandLocaleRedirects(rules) {
  return rules.flatMap((rule) => [
    rule,
    ...PATH_LOCALE_PREFIXES.map((prefix) => ({
      ...rule,
      source: `${prefix}${rule.source}`,
      destination: rule.destination.startsWith('http')
        ? rule.destination
        : // `/es` + `/` is `/es/`, and Next unshifts its own `/:path+/ → /:path+`
          // 308 ahead of every custom rule while `trailingSlash` is at its
          // default — so the naive twin would cost the reader a second hop. Next
          // normalises the same case in its own i18n expansion
          // (`load-custom-routes.js`: `destination === '/' && !trailingSlash`).
          rule.destination === '/'
          ? prefix
          : `${prefix}${rule.destination}`,
    })),
  ]);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Pin this explicitly. Next otherwise discovers the tracing root by walking
  // for a lockfile, but the isolated Expo web runtime has its own nested
  // pnpm-lock.yaml. Trace paths and the standalone layout must stay rooted at
  // the monorepo regardless of which lockfile Next encounters first.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'assets.boardsesh.com',
        pathname: '/static/v1/**',
      },
    ],
  },
  // Dev-only: let the HMR + RSC-debug WebSockets complete when the page is
  // opened via the machine's Tailscale hostname. Next dev only allows
  // localhost origins by default and hangs the WS handshake for anything else;
  // because the RSC debug channel rides the same transport, a blocked origin
  // stops hydration entirely (SSR renders, zero client-side execution).
  // scripts/dev-with-tailscale.ts sets DEV_ALLOWED_ORIGINS to the resolved
  // Tailscale hostname; empty outside that flow (localhost stays allowed).
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS ? process.env.DEV_ALLOWED_ORIGINS.split(',') : [],
  typescript: {
    // ignoreBuildErrors: true,
  },
  // Transpile internal monorepo packages from TypeScript source
  // This eliminates the need to pre-build packages before running the web app
  transpilePackages: [
    '@boardsesh/board-constants',
    '@boardsesh/aurora-sync',
    '@boardsesh/shared-schema',
    '@boardsesh/static-assets',
    '@boardsesh/db',
    '@boardsesh/crypto',
    '@boardsesh/moonboard-ocr',
    '@boardsesh/ble-protocol',
    '@boardsesh/board-config',
    '@boardsesh/board-look',
    '@boardsesh/board-render',
    '@boardsesh/graphql',
    '@boardsesh/graphql-client',
    '@boardsesh/queue',
    '@boardsesh/queue-runtime',
    '@boardsesh/queue-react',
    '@boardsesh/playlists-react',
    '@boardsesh/board-react',
    '@boardsesh/party-profile',
    '@boardsesh/analytics',
    '@boardsesh/climb-actions',
    '@boardsesh/play-view',
    '@boardsesh/playback-react',
    '@boardsesh/climb-filters',
    '@boardsesh/i18n',
    '@boardsesh/velvet-tokens',
    '@boardsesh/logbook',
    '@boardsesh/email',
  ],
  // `postgres` (postgres.js, used by @boardsesh/db via drizzle-orm/postgres-js)
  // must stay OUT of the server bundle. Sentry's postgresJsIntegration patches
  // the driver through OpenTelemetry's require-hook, which only fires for
  // modules the bundler leaves external. Neither Next's own externals list nor
  // @sentry/nextjs's DEFAULT_SERVER_EXTERNAL_PACKAGES includes it — both list
  // `pg`, which we do not use — so without this line every `db.query` span is
  // silently missing and Sentry's Queries view is empty with no error anywhere.
  // withSentryConfig merges rather than replaces this list, so it composes.
  serverExternalPackages: ['postgres'],
  // Empty turbopack config to silence warning about webpack config
  turbopack: {},
  experimental: {
    // Size the page-data workers from availableParallelism, not Next's
    // default. Next derives its worker count from `os.cpus().length`, which
    // reports every CPU on the machine and ignores cgroup/cpuset limits --
    // Node's own docs warn against using it for exactly this.
    //
    // Measured in the CI runner image under `--cpuset-cpus=0-2`:
    //
    //   nproc                       3
    //   os.cpus().length           18   <-- what Next reads
    //   os.availableParallelism()   3
    //
    // So on a 3-CPU container Next spawned 17 workers (18 - 1), each a Node
    // process good for ~1 GB, and the host ran out of memory. It surfaced as
    // `Next.js build worker exited with code: null and signal: SIGBUS` on
    // every self-hosted runner while passing GitHub-hosted, where a runner
    // has 4 CPUs and the arithmetic happens to be survivable.
    //
    // availableParallelism respects affinity, so this is correct on a
    // constrained container, an unconstrained one, and a developer laptop
    // alike -- no environment variable to keep in sync with the runner config.
    cpus: Math.max(1, os.availableParallelism() - 1),
    optimizePackageImports: ['@mui/material', '@mui/icons-material', '@mui/material-nextjs'],
    // Next's build-time type check normally drives the TypeScript compiler API,
    // which 7.0 no longer ships. This routes that step through `tsc` instead.
    useTypeScriptCli: true,
    // Tree-shake the gql.ts Documents map by rewriting graphql(`...`) calls
    // into direct imports of the matching *Document constant.
    // - Runs during `next build` (Turbopack production); does not run under
    //   `next dev`, so local dev still bundles the full map.
    // - artifactDirectory is resolved against the workspace root pinned by
    //   outputFileTracingRoot, not packages/web — hence the
    //   `./packages/web/...` prefix. A wrong path may either silently no-op or trip
    //   module-not-found, so changes here must be verified by running
    //   `vp run boardsesh-monorepo#verify:graphql-treeshake` after a build.
    swcPlugins: [
      [
        '@swc-contrib/plugin-graphql-codegen-client-preset',
        {
          artifactDirectory: './packages/shared/graphql/src/generated',
          gqlTagName: 'graphql',
        },
      ],
    ],
  },
  outputFileTracingExcludes: {
    '/**': ['./e2e/**', './**/*.test.*', './**/*.spec.*'],
  },
  async headers() {
    return [
      {
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
      // No /app rules live here any more (W-24, #4438). The browser app ships at
      // app.boardsesh.com, whose response headers come from
      // deploy/app-subdomain/_headers. The only /app surface left on www is the
      // dev Metro proxy, and an external rewrite forwards Metro's own response
      // headers straight past headers() — so middleware.ts is what stamps
      // noindex/XFO/nosniff/HSTS there, pinned against Metro's canonical
      // constants by expo-web-header-parity.test.ts.
      {
        // Every route EXCEPT /embed/** keeps the frame-denying default.
        // If this exclusion ever regresses, the fail-safe is SAMEORIGIN
        // (embeds break visibly rather than the whole site becoming frameable).
        source: '/((?!embed/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // /embed/** — iframe widgets for gym websites (live board view, gym
        // leaderboard). Display-only, cookieless, no authenticated action;
        // review rule: no auth-dependent UI under app/embed/**. They must be
        // frameable by ANY origin, hence `frame-ancestors *` and NO
        // X-Frame-Options (frame-ancestors takes precedence over XFO in
        // modern browsers; omitting XFO keeps legacy browsers from denying).
        // The middleware 308s every locale-prefixed /embed/** (es, fr, de —
        // the pattern derives from SUPPORTED_LOCALES, so a new locale can't
        // silently drift out of it) to the un-prefixed path, because this
        // matcher sees the ORIGINAL request path — a prefixed variant would
        // fall into the SAMEORIGIN rule above.
        // `:path+` (one or more segments), NOT `:path*`: the exclusion regex
        // above only skips paths starting `embed/` (with slash), so a bare
        // `/embed` matches the SAMEORIGIN rule — with `:path*` it would match
        // BOTH rules and ship contradictory XFO + frame-ancestors on one
        // response. `/embed` exact is not a route; it stays frame-denying.
        source: '/embed/:path+',
        headers: [
          { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  async rewrites() {
    // Released Live Activities, ESP32 firmware and already-crawled HTML still
    // request this path. Keep it as a routing-layer proxy so they receive the
    // Railway image bytes without invoking a Next.js function.
    const boardRenderCompatibilityRewrite = {
      source: '/api/internal/board-render',
      destination: resolveBoardRenderBackendUrl(process.env.NEXT_PUBLIC_WS_URL),
    };
    // Same-origin path to the traced board art, for the browser's WASM
    // renderer. Same reason as the rewrite above: routing layer only, no
    // Next.js function invoked.
    const boardGeometryRewrite = {
      source: '/api/internal/board-geometry',
      destination: resolveBoardGeometryBackendUrl(process.env.NEXT_PUBLIC_WS_URL),
    };

    if (process.env.BOARDSESH_WEB !== '1') {
      return { beforeFiles: [boardRenderCompatibilityRewrite, boardGeometryRewrite] };
    }

    const expoWebOrigin = resolveExpoWebDevOrigin(process.env.BOARDSESH_EXPO_WEB_ORIGIN);
    if (!expoWebOrigin) {
      // Production never serves /app (W-24, #4438). The Expo browser app ships
      // only at app.boardsesh.com; www's /app was a legacy static-export path
      // whose artifact the Vercel build never produced, so it 404'd anyway.
      // Keeping the SPA fallback behind NODE_ENV=development preserves
      // `vp run dev:mobile:web-static` (bake once, serve at /app over the
      // tailnet for device QA) while guaranteeing no production build — Vercel
      // or Dockerfile.web — can ever bake an /app route again. That guarantee
      // is what makes #3795 (web → Railway, whose image DOES build from
      // Dockerfile.web) safe to land after this.
      if (process.env.NODE_ENV !== 'development') {
        return { beforeFiles: [boardRenderCompatibilityRewrite, boardGeometryRewrite] };
      }

      console.warn(
        '[next.config] BOARDSESH_WEB=1 but BOARDSESH_EXPO_WEB_ORIGIN is unset — serving the static export from public/app if present (development only; production never serves /app).',
      );
      return {
        beforeFiles: [
          boardRenderCompatibilityRewrite,
          boardGeometryRewrite,
          { source: '/app', destination: '/app/index.html' },
          // SPA fallback for Expo Router routes ONLY. The content-hashed
          // namespaces (_expo/, assets/) and the fixed-name WASM glue (wasm/) stay
          // excluded so a request for a missing hashed bundle 404s instead of
          // silently serving the HTML shell at a .js/.wasm URL.
          { source: '/app/:path((?!_expo/|assets/|wasm/).*)', destination: '/app/index.html' },
        ],
      };
    }

    // Development: proxy /app (and Metro's support namespaces) to the Expo dev
    // server. beforeFiles, not the default afterFiles, so a stale local export
    // sitting in public/app can never shadow Metro while the proxy is active.
    return {
      beforeFiles: [
        boardRenderCompatibilityRewrite,
        boardGeometryRewrite,
        {
          source: '/app',
          destination: `${expoWebOrigin}/app`,
        },
        {
          // Expo serves public/ from its server root during `expo start`, while
          // the production baseUrl makes browser imports point under /app.
          // Resolve the committed WASM glue/binary before the SPA catch-all.
          source: '/app/wasm/:path*',
          destination: `${expoWebOrigin}/wasm/:path*`,
        },
        {
          // Same public/ root-vs-baseUrl mismatch as the WASM rule above: the
          // PWA manifest (packages/mobile/public/manifest.json) is served by
          // Metro unprefixed, so /app/manifest.json must resolve before the SPA
          // catch-all or it 404s into the exported shell instead of real JSON.
          source: '/app/manifest.json',
          destination: `${expoWebOrigin}/manifest.json`,
        },
        {
          source: '/app/:path*',
          destination: `${expoWebOrigin}/app/:path*`,
        },
        {
          // Expo's development shell emits the Metro entry URL from the
          // monorepo-relative module path even when baseUrl is /app. Keep that
          // narrow namespace on the same browser origin while forwarding it to
          // Metro; application/API routes remain owned by Next.
          source: '/packages/mobile/:path*',
          destination: `${expoWebOrigin}/packages/mobile/:path*`,
        },
        {
          // Metro serves vector-icon fonts and other resolved module assets from
          // this query-driven endpoint (for example `/assets?unstable_path=...`).
          source: '/assets',
          destination: `${expoWebOrigin}/assets`,
        },
        {
          source: '/assets/:path*',
          destination: `${expoWebOrigin}/assets/:path*`,
        },
      ],
    };
  },
  async redirects() {
    return expandLocaleRedirects(BASE_REDIRECTS);
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: 'boardsesh',

  project: 'boardsesh',

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: '/monitoring',

  webpack: {
    // Off since #4654: cron monitors now come from packages/scheduler
    // (Sentry.withMonitor per job), and vercel.json declares no crons for
    // this to instrument. See docs/scheduler.md.
    automaticVercelMonitors: false,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
