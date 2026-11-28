/** Keep SQLite QA fixtures out of store bundles and live application startup. */
export function loadOfflineWriteRoot(): typeof import('./root').default | null {
  return __DEV__ ? (require('./root') as typeof import('./root')).default : null;
}

export function loadOfflineWriteScreen(): typeof import('./screen').default | null {
  return __DEV__ ? (require('./screen') as typeof import('./screen')).default : null;
}

export function loadOfflineWriteErrorBoundary(): typeof import('./root').OfflineWriteErrorBoundary | null {
  return __DEV__ ? (require('./root') as typeof import('./root')).OfflineWriteErrorBoundary : null;
}
