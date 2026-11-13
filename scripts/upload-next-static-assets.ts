import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { publishNextStaticAssets } from './lib/next-static-assets';

export function parseNextStaticAssetArguments(arguments_: readonly string[]): { directory: string } {
  const forwardedArguments = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;
  if (
    forwardedArguments.length !== 2 ||
    forwardedArguments[0] !== '--directory' ||
    !forwardedArguments[1]?.trim() ||
    forwardedArguments[1].startsWith('--')
  ) {
    throw new Error('Usage: vp run upload:next-static-assets -- --directory <extracted .next/static directory>');
  }
  return { directory: forwardedArguments[1] };
}

export function readNextStaticAssetEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  function required(name: string): string {
    const contents = environment[name]?.trim();
    if (!contents) throw new Error(`Missing required environment variable: ${name}`);
    return contents;
  }
  const endpoint = required('STATIC_ASSETS_AWS_ENDPOINT_URL');
  const endpointUrl = new URL(endpoint);
  if (
    endpointUrl.protocol !== 'https:' ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash
  )
    throw new Error('STATIC_ASSETS_AWS_ENDPOINT_URL must be an HTTPS endpoint without credentials, query, or fragment');
  return {
    bucket: required('STATIC_ASSETS_S3_BUCKET_NAME'),
    endpoint,
    region: required('STATIC_ASSETS_AWS_REGION'),
    credentials: {
      accessKeyId: required('STATIC_ASSETS_AWS_ACCESS_KEY_ID'),
      secretAccessKey: required('STATIC_ASSETS_AWS_SECRET_ACCESS_KEY'),
    },
  };
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { directory } = parseNextStaticAssetArguments(arguments_);
  const { bucket, ...configuration } = readNextStaticAssetEnvironment();
  // The publisher owns retries so one attempt's deadline includes the complete streamed body.
  const client = new S3Client({ ...configuration, maxAttempts: 1 });
  try {
    const result = await publishNextStaticAssets({ directory, bucket, client });
    console.log(
      `Next static assets verified: ${result.assets} files, ${result.uploaded} uploaded, ${result.existing} retained, ${result.bytes} bytes. No objects deleted.`,
    );
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
