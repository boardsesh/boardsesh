import { withSentryConfig } from '@sentry/nextjs';
import createWithVercelToolbar from '@vercel/toolbar/plugins/next';
// next.config.js

const withVercelToolbar = createWithVercelToolbar();

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

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  typescript: {
    // ignoreBuildErrors: true,
  },
  // Transpile internal monorepo packages from TypeScript source
  // This eliminates the need to pre-build packages before running the web app
  transpilePackages: [
    '@boardsesh/board-constants',
    '@boardsesh/aurora-sync',
    '@boardsesh/shared-schema',
    '@boardsesh/db',
    '@boardsesh/crypto',
    '@boardsesh/moonboard-ocr',
    '@boardsesh/ble-protocol',
    '@boardsesh/board-config',
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
  // Empty turbopack config to silence warning about webpack config
  turbopack: {},
  experimental: {
    optimizePackageImports: ['@mui/material', '@mui/icons-material', '@mui/material-nextjs'],
    // Tree-shake the gql.ts Documents map by rewriting graphql(`...`) calls
    // into direct imports of the matching *Document constant.
    // - Runs during `next build` (Turbopack production); does not run under
    //   `next dev`, so local dev still bundles the full map.
    // - artifactDirectory is resolved against the workspace root (where
    //   bun.lock lives), not packages/web — hence the `./packages/web/...`
    //   prefix. A wrong path may either silently no-op or trip
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
  // Include WASM binary in standalone output for serverless functions.
  // Both paths needed: monorepo root (hoisted deps) and local node_modules (symlink).
  outputFileTracingExcludes: {
    '/**': ['./e2e/**', './**/*.test.*', './**/*.spec.*'],
  },
  outputFileTracingIncludes: {
    '/api/internal/board-render': [
      './node_modules/@boardsesh/board-renderer-wasm/pkg/*.wasm',
      '../../node_modules/@boardsesh/board-renderer-wasm/pkg/*.wasm',
      './public/images/**',
    ],
  },
  async headers() {
    return [
      {
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
      {
        // Expo web is an authenticated utility surface. Keep it out of search
        // while it is rolled out behind the /app proxy.
        source: '/app/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, follow' }],
      },
      {
        // Exported Expo web bundles are content-hashed (entry-<hash>.js under
        // _expo/static, md5-named files under assets/), so they can be cached
        // forever. The SPA shell (/app/index.html) and the fixed-name WASM glue
        // under /app/wasm keep the default no-store-ish behaviour on purpose.
        source: '/app/:hashedDir(_expo|assets)/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
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
        // The middleware 308s locale-prefixed /es|fr/embed/** to the
        // un-prefixed path because this matcher sees the ORIGINAL request
        // path — a prefixed variant would fall into the SAMEORIGIN rule above.
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
    if (process.env.BOARDSESH_WEB !== '1') return [];

    const expoWebOrigin = resolveExpoWebDevOrigin(process.env.BOARDSESH_EXPO_WEB_ORIGIN);
    if (!expoWebOrigin) {
      // In dev, BOARDSESH_WEB=1 with no BOARDSESH_EXPO_WEB_ORIGIN usually means
      // a half-configured Metro proxy — surface it (the static-export fallback
      // below still applies if public/app was built). In production this is the
      // intended configuration: no Metro, serve the static export.
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          '[next.config] BOARDSESH_WEB=1 but BOARDSESH_EXPO_WEB_ORIGIN is unset — Expo web /app dev proxy is disabled; serving the static export from public/app if present.',
        );
      }
      // Production: no Metro to proxy to. The static Expo web export is copied
      // into public/app (scripts/build-expo-web-export.sh; Dockerfile.web runs
      // it in the builder stage), so real files — /app/_expo/* bundles,
      // /app/assets/*, /app/wasm/* — are served straight from public/ before
      // these afterFiles rewrites are consulted. Everything else under /app is
      // an Expo Router SPA route and falls back to the exported shell. When the
      // export was not built into the deploy, /app/index.html resolves to
      // nothing and /app 404s — that absence is the rollback lever (see
      // docs/expo-web-deployment.md).
      return [
        { source: '/app', destination: '/app/index.html' },
        // SPA fallback for Expo Router routes ONLY. The content-hashed namespaces
        // (_expo/, assets/) and the fixed-name WASM glue (wasm/) are excluded so a
        // request for a missing hashed bundle 404s instead of falling through to
        // the shell. Otherwise Next's headers() would stamp the index.html body
        // with the immutable Cache-Control that matches the incoming .js/.wasm path
        // (line 105), and a stale-shell or mid-deploy client would cache an HTML
        // page at a bundle URL forever — permanently bricking that URL.
        { source: '/app/:path((?!_expo/|assets/|wasm/).*)', destination: '/app/index.html' },
      ];
    }

    // Development: proxy /app (and Metro's support namespaces) to the Expo dev
    // server. beforeFiles, not the default afterFiles, so a stale local export
    // sitting in public/app can never shadow Metro while the proxy is active.
    return {
      beforeFiles: [
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
    return [
      // Redirect old playlist routes to /playlists
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
    ];
  },
};

export default withVercelToolbar(
  withSentryConfig(nextConfig, {
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
      // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
      // See the following for more information:
      // https://docs.sentry.io/product/crons/
      // https://vercel.com/docs/cron-jobs
      automaticVercelMonitors: true,

      // Tree-shaking options for reducing bundle size
      treeshake: {
        // Automatically tree-shake Sentry logger statements to reduce bundle size
        removeDebugLogging: true,
      },
    },
  }),
);
