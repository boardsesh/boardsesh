/** Dev-only lazy entry points. No application providers or fixture modules are imported eagerly. */
/** The story index and story screens, or `null` in a production bundle. */
export function loadStoryScreens(): typeof import('./screens') | null {
  return __DEV__ ? (require('./screens') as typeof import('./screens')) : null;
}

/** Isolated presentation root, never collected by production Metro. */
export function loadStoryRoot(): typeof import('./StoryRoot').default | null {
  return __DEV__ ? (require('./StoryRoot') as typeof import('./StoryRoot')).default : null;
}

export function loadStoryErrorBoundary(): typeof import('./StoryRoot').StoryRootErrorBoundary | null {
  return __DEV__ ? (require('./StoryRoot') as typeof import('./StoryRoot')).StoryRootErrorBoundary : null;
}

/** Actual ActivityKit setup; never a React Native imitation of system UI. */
export function loadNativeActivitySetup(): typeof import('./NativeActivitySetup').default | null {
  return __DEV__ ? (require('./NativeActivitySetup') as typeof import('./NativeActivitySetup')).default : null;
}

/** Real native/tab navigation, still isolated from application services. */
export function loadStoryTabLayouts(): typeof import('./StoryTabLayout') | null {
  return __DEV__ ? (require('./StoryTabLayout') as typeof import('./StoryTabLayout')) : null;
}
