/** Source inputs shared by retained capture verification and isolated story provenance. */
export function isReplayCapturePath(path: string): boolean {
  return (
    (path === 'app-stores/apple/custom-product-pages.json' ||
      path === '.github/actions/ios-screenshot-shard/action.yml' ||
      path === 'scripts/mobile-screenshots.ts' ||
      path === 'scripts/frame-screenshots.ts' ||
      [
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'vite.config.ts',
        'scripts/mobile-build-sim-app.ts',
        'scripts/mobile-ios-run.ts',
        'scripts/screenshot-sim.entitlements',
      ].includes(path) ||
      path.startsWith('patches/') ||
      /^scripts\/assert-(cpp-)?screenshot/.test(path) ||
      path.startsWith('scripts/lib/') ||
      path.startsWith('packages/mobile/.maestro/') ||
      path.startsWith('app-stores/presentation/') ||
      (path.startsWith('packages/shared/') && !/^packages\/shared\/(?:pr-body|email)\//.test(path)) ||
      path.startsWith('packages/board-constants/') ||
      /^packages\/mobile\/(?:app|src|plugins|modules|assets|locales)\//.test(path) ||
      /^packages\/mobile\/[^/]+\.(?:json|[cm]?[jt]s)$/.test(path)) &&
    !path.includes('/__tests__/') &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}
