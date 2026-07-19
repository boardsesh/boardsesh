export type DevServerPortRequest = {
  port: number;
  envName: 'BACKEND_PORT' | 'PORT' | 'EXPO_WEB_PORT';
  explicit: boolean;
};

export type DevServerPortRequests = {
  backend: DevServerPortRequest;
  web: DevServerPortRequest;
  expoWeb: DevServerPortRequest | null;
};

export type DevServerPorts = {
  backendPort: number;
  webPort: number;
  expoWebPort: number | null;
};

export type PortAvailabilityCheck = (port: number) => Promise<boolean>;

type DevServerService = keyof DevServerPortRequests;

const MAX_PORT_ATTEMPTS = 10;

/**
 * Allocate every dev-service port together so a fallback selected for one
 * service cannot be selected again before that service has started listening.
 * Explicit ports are reserved first so automatic fallbacks never consume a
 * port the caller asked another service to use.
 */
export async function allocateDevServerPorts(
  requests: DevServerPortRequests,
  isPortInUse: PortAvailabilityCheck,
  maxAttempts = MAX_PORT_ATTEMPTS,
): Promise<DevServerPorts> {
  const serviceRequests: Array<readonly [DevServerService, DevServerPortRequest | null]> = [
    ['backend', requests.backend],
    ['web', requests.web],
    ['expoWeb', requests.expoWeb],
  ];
  const allocatedByPort = new Map<number, DevServerPortRequest>();
  const allocatedByService = new Map<DevServerService, number>();

  for (const [service, request] of serviceRequests) {
    if (!request?.explicit) continue;

    const existingRequest = allocatedByPort.get(request.port);
    if (existingRequest) {
      throw new Error(
        `Port ${request.port} is requested by both ${existingRequest.envName} and ${request.envName}. ` +
          'Each dev service needs a distinct port.',
      );
    }

    if (await isPortInUse(request.port)) {
      throw new Error(`Port ${request.port} (${request.envName}) is in use.`);
    }

    allocatedByPort.set(request.port, request);
    allocatedByService.set(service, request.port);
  }

  for (const [service, request] of serviceRequests) {
    if (!request || request.explicit) continue;

    let allocatedPort: number | null = null;
    for (let offset = 0; offset < maxAttempts; offset++) {
      const candidatePort = request.port + offset;
      if (allocatedByPort.has(candidatePort)) continue;
      if (await isPortInUse(candidatePort)) continue;

      allocatedPort = candidatePort;
      break;
    }

    if (allocatedPort === null) {
      throw new Error(`Could not find an available port for ${request.envName} starting from ${request.port}.`);
    }

    allocatedByPort.set(allocatedPort, request);
    allocatedByService.set(service, allocatedPort);
  }

  const backendPort = allocatedByService.get('backend');
  const webPort = allocatedByService.get('web');
  if (backendPort === undefined || webPort === undefined) {
    throw new Error('Backend and web ports must be allocated.');
  }

  return {
    backendPort,
    webPort,
    expoWebPort: requests.expoWeb ? (allocatedByService.get('expoWeb') ?? null) : null,
  };
}
