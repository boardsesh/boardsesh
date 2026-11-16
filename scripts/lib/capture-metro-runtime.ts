import { execFileSync } from 'node:child_process';
import { metroProcessEnv } from './metro-dev-server';
import { parseResolverOutput } from './mobile-runtime-version';

type RuntimeResolver = (mobileRoot: string, env: NodeJS.ProcessEnv) => string;

const resolveIosRuntime: RuntimeResolver = (mobileRoot, env) =>
  execFileSync('vp', ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', 'ios'], {
    cwd: mobileRoot,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Resolve once for an immutable iOS capture Metro, never a watched development session. */
export function captureMetroRuntimeEnv(
  env: NodeJS.ProcessEnv,
  mobileRoot: string,
  resolveRuntime: RuntimeResolver = resolveIosRuntime,
): NodeJS.ProcessEnv {
  const captureEnv = metroProcessEnv(env);
  if (captureEnv.EXPO_UPDATES_FINGERPRINT_OVERRIDE?.trim()) return captureEnv;
  const startedAt = Date.now();
  let stdout: string;
  try {
    stdout = resolveRuntime(mobileRoot, captureEnv);
  } catch {
    // Child output can contain configuration values; keep failures diagnostic without exposing it.
    throw new Error('Could not resolve the iOS capture Metro runtime within 120 seconds');
  }
  const { runtimeVersion } = parseResolverOutput(stdout);
  if (typeof runtimeVersion !== 'string' || !runtimeVersion.trim() || runtimeVersion !== runtimeVersion.trim()) {
    throw new Error('iOS capture runtime resolver returned an invalid runtimeVersion');
  }
  console.log(`[mobile:screenshots] Resolved iOS capture Metro runtime in ${Date.now() - startedAt}ms.`);
  return { ...captureEnv, EXPO_UPDATES_FINGERPRINT_OVERRIDE: runtimeVersion };
}
