const { createRunOncePlugin, withDangerousMod } = require('expo/config-plugins');
const path = require('node:path');
const fs = require('node:fs');

// AppCheckCore (pulled in by @react-native-google-signin/google-signin via
// FirebaseAppCheck) is a Swift pod that imports GoogleUtilities and
// RecaptchaInterop. CocoaPods refuses to link them as static libraries when
// they don't define modules. Adding :modular_headers => true makes CocoaPods
// generate module maps for them so AppCheckCore can import them cleanly.
const PODS = ['GoogleUtilities', 'RecaptchaInterop'];
const MARKER = '# boardsesh: app-check-modular-headers';

function withPodfileAppCheckFix(config) {
  return withDangerousMod(config, [
    'ios',
    (modConfig) => {
      const podfilePath = path.join(modConfig.modRequest.platformProjectRoot, 'Podfile');
      let podfile = fs.readFileSync(podfilePath, 'utf8');

      if (podfile.includes(MARKER)) {
        return modConfig;
      }

      const anchor = 'use_expo_modules!';
      const anchorIndex = podfile.indexOf(anchor);
      if (anchorIndex === -1) {
        console.warn('[with-podfile-app-check-fix] use_expo_modules! not found in Podfile — skipping fix.');
        return modConfig;
      }

      const insertAfter = anchorIndex + anchor.length;
      const declarations = PODS.map((pod) => `  pod '${pod}', :modular_headers => true`).join('\n');
      const insertion = `\n${MARKER}\n${declarations}`;

      podfile = podfile.slice(0, insertAfter) + insertion + podfile.slice(insertAfter);
      fs.writeFileSync(podfilePath, podfile);
      return modConfig;
    },
  ]);
}

module.exports = createRunOncePlugin(withPodfileAppCheckFix, 'with-podfile-app-check-fix', '1.0.0');
