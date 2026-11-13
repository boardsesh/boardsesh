interface DatabasePoolClosures {
  readonly credential: () => Promise<void>;
  readonly read: () => Promise<void>;
  readonly primary: () => Promise<void>;
  readonly admission: () => Promise<void>;
}

/** Each owner gets a cleanup attempt. Admission stays available until the others settle. */
export async function closeDatabasePools(closures: DatabasePoolClosures): Promise<boolean> {
  const results = await Promise.allSettled([
    Promise.resolve().then(closures.credential),
    Promise.resolve().then(closures.read),
    Promise.resolve().then(closures.primary),
  ]);
  try {
    await closures.admission();
  } catch {
    return false;
  }
  return results.every((result) => result.status === 'fulfilled');
}
