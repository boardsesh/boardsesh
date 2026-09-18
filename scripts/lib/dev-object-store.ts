import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

function requiredEnvironment(name: string): string {
  const configured = process.env[name]?.trim();
  if (!configured) throw new Error(`Missing ${name}; see .env.dev-artifacts.example`);
  return configured;
}

/** Publishes developer artifacts with isolated credentials and verifies the public bytes. */
export function createDevObjectPublisher(): (key: string, bytes: Buffer, contentType: string) => Promise<string> {
  const environment = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local');
  if (existsSync(environment)) loadEnvFile(environment);
  const bucket = requiredEnvironment('DEV_S3_BUCKET_NAME');
  const endpoint = requiredEnvironment('DEV_AWS_ENDPOINT_URL');
  const publicBase = requiredEnvironment('DEV_PUBLIC_BASE_URL').replace(/\/$/, '');
  if (new URL(endpoint).protocol !== 'https:' || new URL(publicBase).protocol !== 'https:') {
    throw new Error('Dev artifact endpoint and public URL must use HTTPS');
  }
  const client = new S3Client({
    endpoint,
    region: process.env.DEV_AWS_REGION || 'auto',
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnvironment('DEV_AWS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('DEV_AWS_SECRET_ACCESS_KEY'),
    },
  });
  return async (key, bytes, contentType) => {
    if (!/^[\w./-]+$/.test(key) || key.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Invalid dev artifact key');
    }
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    const url = `${publicBase}/${key}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Published artifact returned HTTP ${response.status}: ${url}`);
    const uploadedHash = createHash('sha256')
      .update(Buffer.from(await response.arrayBuffer()))
      .digest('hex');
    if (uploadedHash !== createHash('sha256').update(bytes).digest('hex')) {
      throw new Error(`Published artifact checksum differs: ${url}`);
    }
    return url;
  };
}
