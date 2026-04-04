const DEFAULT_CERT_FINGERPRINTS: string[] = [];

function getCertFingerprints(): string[] {
  const configuredFingerprints = process.env.ANDROID_APP_LINK_CERT_FINGERPRINTS;

  if (!configuredFingerprints) {
    return DEFAULT_CERT_FINGERPRINTS;
  }

  return configuredFingerprints
    .split(',')
    .map((fingerprint) => fingerprint.trim())
    .filter(Boolean);
}

export function GET(): Response {
  const assetLinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.boardsesh.app',
        sha256_cert_fingerprints: getCertFingerprints(),
      },
    },
  ];

  return new Response(JSON.stringify(assetLinks), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
