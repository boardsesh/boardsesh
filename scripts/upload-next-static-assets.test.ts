import { describe, expect, it } from 'vite-plus/test';
import { parseNextStaticAssetArguments, readNextStaticAssetEnvironment } from './upload-next-static-assets';

const environment = {
  STATIC_ASSETS_S3_BUCKET_NAME: 'static-assets',
  STATIC_ASSETS_AWS_ENDPOINT_URL: 'https://account.r2.cloudflarestorage.com',
  STATIC_ASSETS_AWS_REGION: 'auto',
  STATIC_ASSETS_AWS_ACCESS_KEY_ID: 'test-access',
  STATIC_ASSETS_AWS_SECRET_ACCESS_KEY: 'test-secret',
};

describe('Next static asset publisher CLI', () => {
  it('requires one explicit extracted static directory and rejects unknown/repeated options', () => {
    expect(parseNextStaticAssetArguments(['--directory', '/tmp/extracted/.next/static'])).toEqual({
      directory: '/tmp/extracted/.next/static',
    });
    expect(parseNextStaticAssetArguments(['--', '--directory', '/tmp/extracted/.next/static'])).toEqual({
      directory: '/tmp/extracted/.next/static',
    });
    for (const arguments_ of [
      [],
      ['--directory'],
      ['--directory', ''],
      ['--directory', '--delete'],
      ['--directory', '/tmp/static', '--delete'],
      ['--bucket', 'other'],
      ['--', '--', '--directory', '/tmp/static'],
      ['--', '--directory', '/tmp/static', '--delete'],
    ]) {
      expect(() => parseNextStaticAssetArguments(arguments_)).toThrow('Usage:');
    }
  });

  it('uses only the existing explicitly prefixed storage configuration', () => {
    expect(readNextStaticAssetEnvironment(environment)).toEqual({
      bucket: 'static-assets',
      endpoint: environment.STATIC_ASSETS_AWS_ENDPOINT_URL,
      region: 'auto',
      credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
    });
    for (const key of Object.keys(environment)) {
      expect(() =>
        readNextStaticAssetEnvironment({
          ...environment,
          [key]: '',
          AWS_ENDPOINT_URL: environment.STATIC_ASSETS_AWS_ENDPOINT_URL,
          AWS_REGION: 'wrong',
          AWS_ACCESS_KEY_ID: 'wrong',
          AWS_SECRET_ACCESS_KEY: 'wrong',
        }),
      ).toThrow(key);
    }
  });

  it('refuses plaintext or credential-bearing storage endpoints', () => {
    for (const endpoint of [
      'http://storage.example',
      'https://user:password@storage.example',
      'https://storage.example?token=secret',
    ]) {
      expect(() =>
        readNextStaticAssetEnvironment({ ...environment, STATIC_ASSETS_AWS_ENDPOINT_URL: endpoint }),
      ).toThrow('HTTPS endpoint');
    }
  });
});
