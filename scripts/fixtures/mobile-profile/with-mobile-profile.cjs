const { withAndroidManifest, withDangerousMod, withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

function namespace(text) {
  return text.replace(/com\.boardsesh\.app(?!\.perf)/g, 'com.boardsesh.app.perf');
}

function rewriteGeneratedIos(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'Pods' || entry.name === 'build' || entry.name.startsWith('.')) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) rewriteGeneratedIos(filename);
    else if (/\.(plist|entitlements|pbxproj|swift|m|mm|h|json)$/.test(entry.name)) {
      const original = fs.readFileSync(filename, 'utf8');
      const namespaced = namespace(original);
      if (namespaced !== original) fs.writeFileSync(filename, namespaced);
    }
  }
}

module.exports = function withMobileProfile(config) {
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults = JSON.parse(namespace(JSON.stringify(mod.modResults)));
    return mod;
  });
  config = withInfoPlist(config, (mod) => {
    mod.modResults = JSON.parse(namespace(JSON.stringify(mod.modResults)));
    mod.modResults.CFBundleURLTypes = [{ CFBundleURLSchemes: ['boardsesh-perf'] }];
    mod.modResults.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true };
    mod.modResults.NSLocalNetworkUsageDescription = 'Connect to the local performance fixture and measurement server.';
    return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application[0];
    application.$['android:usesCleartextTraffic'] = 'true';
    application.profileable = [{ $: { 'android:shell': 'true' } }];
    application['meta-data'] = application['meta-data'] ?? [];
    const enabled = application['meta-data'].find(
      (entry) => entry.$['android:name'] === 'expo.modules.updates.ENABLED',
    );
    if (enabled) enabled.$['android:value'] = 'false';
    else
      application['meta-data'].push({
        $: { 'android:name': 'expo.modules.updates.ENABLED', 'android:value': 'false' },
      });
    for (const activity of application.activity ?? []) {
      activity['intent-filter'] = (activity['intent-filter'] ?? []).filter(
        (filter) => !filter.data?.some((item) => item.$['android:host']),
      );
      for (const filter of activity['intent-filter'])
        for (const item of filter.data ?? []) {
          if (item.$['android:scheme']) item.$['android:scheme'] = 'boardsesh-perf';
        }
    }
    return mod;
  });
  return withDangerousMod(config, [
    'ios',
    (mod) => {
      rewriteGeneratedIos(mod.modRequest.platformProjectRoot);
      return mod;
    },
  ]);
};

module.exports.namespace = namespace;
