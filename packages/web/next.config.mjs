import { withSentryConfig } from '@sentry/nextjs';
import createWithVercelToolbar from '@vercel/toolbar/plugins/next';
// next.config.js

const withVercelToolbar = createWithVercelToolbar();

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
    '@boardsesh/logbook',
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
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
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
