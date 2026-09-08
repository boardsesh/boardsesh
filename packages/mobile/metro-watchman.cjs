const { spawnSync } = require('node:child_process');

/** Opt-in only: preserve Expo defaults and fail clearly when Watchman is absent. */
function configureWatchman(config, env = process.env, run = spawnSync) {
  if (env.BOARDSESH_METRO_USE_WATCHMAN !== '1') return;
  const watchman = run('watchman', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (watchman.status !== 0) {
    throw new Error('BOARDSESH_METRO_USE_WATCHMAN=1 requires an available Watchman installation.');
  }
  config.resolver.useWatchman = true;
}

module.exports = { configureWatchman };
