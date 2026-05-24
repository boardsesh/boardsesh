// Expo config plugin that patches react-native-screens to prevent a crash
// in [RNSScreen setViewToSnapshot] when a screen is unmounted before its
// view has been fully laid out (zero bounds) or when the snapshot returns nil.
//
// Upstream issue: the Fabric unmount path calls snapshotViewAfterScreenUpdates:
// on a view whose layer hasn't been committed to the render server yet,
// causing CARenderServerSnapshot to crash.
//
// This plugin adds two guards:
// 1. Skip snapshot when the view has empty bounds (layer not yet laid out)
// 2. Skip snapshot usage when snapshotViewAfterScreenUpdates: returns nil

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const ORIGINAL_CONDITION = 'if (self.view.window != nil) {';

const PATCHED_CONDITION = 'if (self.view.window != nil && !CGRectIsEmpty(self.view.bounds)) {';

const ORIGINAL_SNAPSHOT_BLOCK = `    UIView *snapshot = [self.view snapshotViewAfterScreenUpdates:afterUpdates];
    snapshot.frame = self.view.frame;
    [self.view removeFromSuperview];
    self.view = snapshot;
    [superView addSubview:snapshot];`;

const PATCHED_SNAPSHOT_BLOCK = `    UIView *snapshot = [self.view snapshotViewAfterScreenUpdates:afterUpdates];
    if (snapshot != nil) {
      snapshot.frame = self.view.frame;
      [self.view removeFromSuperview];
      self.view = snapshot;
      [superView addSubview:snapshot];
    }`;

function patchRNSScreen(config) {
  return withDangerousMod(config, [
    'ios',
    async (modConfig) => {
      const rnScreensPath = path.join(
        modConfig.modRequest.projectRoot,
        'node_modules',
        'react-native-screens',
        'ios',
        'RNSScreen.mm',
      );

      if (!fs.existsSync(rnScreensPath)) {
        console.warn('[fix-rns-snapshot-crash] RNSScreen.mm not found, skipping patch');
        return modConfig;
      }

      let source = fs.readFileSync(rnScreensPath, 'utf8');

      if (source.includes('CGRectIsEmpty(self.view.bounds)')) {
        console.log('[fix-rns-snapshot-crash] Already patched, skipping');
        return modConfig;
      }

      if (!source.includes(ORIGINAL_CONDITION)) {
        console.warn('[fix-rns-snapshot-crash] Could not find target code — react-native-screens version may have changed');
        return modConfig;
      }

      source = source.replace(ORIGINAL_CONDITION, PATCHED_CONDITION);
      source = source.replace(ORIGINAL_SNAPSHOT_BLOCK, PATCHED_SNAPSHOT_BLOCK);

      fs.writeFileSync(rnScreensPath, source, 'utf8');
      console.log('[fix-rns-snapshot-crash] Patched setViewToSnapshot in RNSScreen.mm');

      return modConfig;
    },
  ]);
}

module.exports = patchRNSScreen;
