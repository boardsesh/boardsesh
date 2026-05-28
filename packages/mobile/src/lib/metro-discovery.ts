export const DEFAULT_METRO_PORTS = [8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089] as const;

export type DiscoveredBundler = {
  host: string;
  port: number;
  url: string;
};

const PROBE_TIMEOUT_MS = 500;
const METRO_STATUS_BODY = 'packager-status:running';

export async function probeMetro(host: string, port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes(METRO_STATUS_BODY);
  } catch {
    return false;
  }
}

export async function discoverBundlers(
  hosts: readonly string[],
  ports: readonly number[] = DEFAULT_METRO_PORTS,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<DiscoveredBundler[]> {
  const probes = hosts.flatMap((host) =>
    ports.map(async (port) => ({
      host,
      port,
      live: await probeMetro(host, port, timeoutMs),
    })),
  );
  const results = await Promise.all(probes);
  return results
    .filter((result) => result.live)
    .map(({ host, port }) => ({ host, port, url: `http://${host}:${port}` }));
}
