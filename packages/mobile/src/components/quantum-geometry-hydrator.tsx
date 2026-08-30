import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QUANTUM_MODELS } from '@boardsesh/board-constants/quantum';
import { getDatabaseHandle } from '../db';
import {
  deleteQuantumGeometryLocal,
  getQuantumGeometryLocal,
  putQuantumGeometryLocal,
} from '../db/queries/quantum-geometry-local';
import { useOfflineSchemaReady } from '../db/use-offline-schema-ready';
import { reportHandledError } from '../lib/error-reporting';
import { getHttpClient } from '../lib/graphql/client';
import { GET_QUANTUM_GEOMETRIES, type GetQuantumGeometriesQueryResponse } from '../lib/graphql/operations';
import {
  getQuantumGeometry,
  registerQuantumGeometry,
  unregisterQuantumGeometry,
  type QuantumGeometryRegistration,
} from '../lib/quantum-geometry-store';

const QUANTUM_GEOMETRY_STALE_TIME_MS = 6 * 60 * 60 * 1000;
const QUANTUM_MODEL_LIST = Object.values(QUANTUM_MODELS);

function reportGeometryFailure(error: unknown, operation: 'read-cache' | 'write-cache'): void {
  reportHandledError(error, {
    tags: { source: 'quantum-geometry', operation },
  });
}

/** Hydrates all five exact models without introducing a context/state owner. */
export function QuantumGeometryHydrator() {
  const schemaReady = useOfflineSchemaReady();
  const authoritativeGeometryKeysRef = useRef<ReadonlySet<string> | null>(null);
  const geometryQuery = useQuery({
    queryKey: ['quantumGeometries'],
    queryFn: () => getHttpClient().request<GetQuantumGeometriesQueryResponse>(GET_QUANTUM_GEOMETRIES),
    select: (response) => response.quantumGeometries,
    staleTime: QUANTUM_GEOMETRY_STALE_TIME_MS,
  });

  useEffect(() => {
    if (!schemaReady) return;
    const database = getDatabaseHandle();
    if (!database) return;

    let cancelled = false;
    void Promise.all(
      QUANTUM_MODEL_LIST.map(({ layoutId, sizeId }) => getQuantumGeometryLocal(database, layoutId, sizeId)),
    )
      .then((cachedGeometries) => {
        for (const cachedGeometry of cachedGeometries) {
          // A network response may win this race. Never let an older cache row
          // replace geometry already accepted during the current app lifetime.
          if (
            !cancelled &&
            cachedGeometry &&
            (authoritativeGeometryKeysRef.current === null ||
              authoritativeGeometryKeysRef.current.has(`${cachedGeometry.layoutId}:${cachedGeometry.sizeId}`)) &&
            !getQuantumGeometry(cachedGeometry.layoutId, cachedGeometry.sizeId)
          ) {
            registerQuantumGeometry(cachedGeometry);
          }
        }
      })
      .catch((error: unknown) => reportGeometryFailure(error, 'read-cache'));

    return () => {
      cancelled = true;
    };
  }, [schemaReady]);

  useEffect(() => {
    const remoteGeometries = geometryQuery.data;
    if (!remoteGeometries) return;
    const database = getDatabaseHandle();
    const acceptedKeys = new Set<string>();
    for (const remoteGeometry of remoteGeometries) {
      const registration: QuantumGeometryRegistration = remoteGeometry;
      if (!registerQuantumGeometry(registration)) continue;
      acceptedKeys.add(`${registration.layoutId}:${registration.sizeId}`);
      if (!schemaReady || !database) continue;
      void putQuantumGeometryLocal(database, registration).catch((error: unknown) =>
        reportGeometryFailure(error, 'write-cache'),
      );
    }
    authoritativeGeometryKeysRef.current = acceptedKeys;
    // The batch is authoritative. A model omitted because its imported rows are
    // incomplete must not stay exposed from an older SQLite snapshot.
    for (const { layoutId, sizeId } of QUANTUM_MODEL_LIST) {
      if (acceptedKeys.has(`${layoutId}:${sizeId}`)) continue;
      unregisterQuantumGeometry(layoutId, sizeId);
      if (!schemaReady || !database) continue;
      void deleteQuantumGeometryLocal(database, layoutId, sizeId).catch((error: unknown) =>
        reportGeometryFailure(error, 'write-cache'),
      );
    }
  }, [geometryQuery.data, schemaReady]);

  return null;
}
