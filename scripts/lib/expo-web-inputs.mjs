// Preserve the browser classifier's public API while OTA and browser pipelines
// share the same app-source, dependency, asset and test/documentation rules.
export {
  isBrowserAppAffecting as isAppAffecting,
  browserAppAffectingPaths as appAffectingPaths,
  hasBrowserAppAffectingChanges as hasAppAffectingChanges,
} from './app-build-inputs.mjs';
