const fs = require('node:fs');
const path = require('node:path');
const { createRunOncePlugin, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

// Spraywall LEDs are driven by a WLED controller on the climber's own network,
// and WLED serves plain HTTP only. Android blocks cleartext in release builds and
// cannot allow-list private IP ranges, so cleartext is permitted by default here
// and refused for every host Boardsesh itself runs.
const NETWORK_SECURITY_CONFIG_NAME = 'boardsesh_network_security_config';
const HTTPS_ONLY_DOMAIN = 'boardsesh.com';

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
  <domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="true">${HTTPS_ONLY_DOMAIN}</domain>
  </domain-config>
</network-security-config>
`;

/**
 * Points the application at the network security config. Pure transform over
 * the @expo/config-plugins manifest object for testability; a second pass leaves
 * the manifest unchanged.
 *
 * @param {{ manifest: { application?: Array<{ $?: Record<string, string> }> } }} androidManifest
 * @returns {typeof androidManifest}
 */
function applyNetworkSecurityConfig(androidManifest) {
  const application = androidManifest.manifest.application?.[0];
  if (!application) throw new Error('with-android-lan-http: AndroidManifest has no <application> element');
  application.$ = {
    ...application.$,
    'android:networkSecurityConfig': `@xml/${NETWORK_SECURITY_CONFIG_NAME}`,
  };
  return androidManifest;
}

function withAndroidLanHttp(config) {
  const withManifest = withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = applyNetworkSecurityConfig(modConfig.modResults);
    return modConfig;
  });
  return withDangerousMod(withManifest, [
    'android',
    async (modConfig) => {
      const directory = path.join(modConfig.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(
        path.join(directory, `${NETWORK_SECURITY_CONFIG_NAME}.xml`),
        NETWORK_SECURITY_CONFIG_XML,
      );
      return modConfig;
    },
  ]);
}

module.exports = createRunOncePlugin(withAndroidLanHttp, 'with-android-lan-http', '1.0.0');
module.exports.applyNetworkSecurityConfig = applyNetworkSecurityConfig;
module.exports.NETWORK_SECURITY_CONFIG_NAME = NETWORK_SECURITY_CONFIG_NAME;
module.exports.NETWORK_SECURITY_CONFIG_XML = NETWORK_SECURITY_CONFIG_XML;
