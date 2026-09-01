// Dockerfile.web replaces this sentinel with the exact Git commit before the
// Next build. Keep the value in source, not a runtime environment variable: a
// Railway/Vercel setting must not let an old container impersonate a new build.
const STAMPED_RELEASE = 'BOARDSESH_BUILD_RELEASE_UNSTAMPED';

export const BUILD_RELEASE = STAMPED_RELEASE.endsWith('_UNSTAMPED') ? 'development' : STAMPED_RELEASE;
