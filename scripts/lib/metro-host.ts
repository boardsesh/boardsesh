import { resolveTailscaleHostname, type TailscaleHostResolution } from './tailscale-hostname';

/** Binding and the manifest's advertised bundle hostname must agree. */
export function resolveMetroHostname(
  args: readonly string[],
  resolveDefault: () => TailscaleHostResolution = resolveTailscaleHostname,
): TailscaleHostResolution {
  let host: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--localhost') host = 'localhost';
    else if (argument === '--lan') host = 'lan';
    else if (argument === '--tunnel') host = 'tunnel';
    else if (argument === '--host') host = args[++index];
    else if (argument.startsWith('--host=')) host = argument.slice('--host='.length);
  }
  return host === 'localhost' ? { hostname: 'localhost', source: 'env' } : resolveDefault();
}
