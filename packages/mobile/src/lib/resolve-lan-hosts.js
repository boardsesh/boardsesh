// Plain JS so Expo's app.config.ts loader (which doesn't transform child
// `.ts` imports) can require this from packages/mobile/app.config.ts.
// Types live in resolve-lan-hosts.d.ts.
const { networkInterfaces } = require('node:os');

function resolveLanHosts(options = {}) {
  const env = options.env ?? process.env;
  // Cloud builders don't have a useful LAN identity for an on-device dev
  // client to reach back to. Skip the lookup to keep extras deterministic.
  if (env.CI || env.EAS_BUILD || env.EAS_BUILD_RUNNER) {
    return [];
  }

  const getInterfaces = options.interfaces ?? networkInterfaces;
  const interfaces = getInterfaces();
  const addresses = [];
  for (const ifaceAddrs of Object.values(interfaces)) {
    if (!ifaceAddrs) continue;
    for (const addr of ifaceAddrs) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      // 169.254/16 link-local addresses aren't routable from another device.
      if (addr.address.startsWith('169.254.')) continue;
      addresses.push(addr.address);
    }
  }
  return Array.from(new Set(addresses));
}

module.exports = { resolveLanHosts };
