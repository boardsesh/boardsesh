// Dockerfile.backend replaces this sentinel with the exact Git commit before
// the image is published. Runtime service variables cannot rewrite the file.
const STAMPED_RELEASE = 'BOARDSESH_BUILD_RELEASE_UNSTAMPED';

export const BUILD_RELEASE = STAMPED_RELEASE.endsWith('_UNSTAMPED') ? 'development' : STAMPED_RELEASE;
