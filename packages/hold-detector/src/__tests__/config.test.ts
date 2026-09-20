import { describe, expect, it } from 'vitest';
import { detectorConfig } from '../config';

const environment = {
  DATABASE_URL: 'postgresql://worker:secret@primary.example:5432/boardsesh?sslmode=verify-full',
  PRIVATE_AWS_ENDPOINT_URL_S3: 'https://storage.example',
  PRIVATE_S3_BUCKET_NAME: 'private',
  PRIVATE_AWS_ACCESS_KEY_ID: 'key',
  PRIVATE_AWS_SECRET_ACCESS_KEY: 'secret',
};
describe('worker configuration', () => {
  it('pins the model and limits inference threads', () => {
    expect(detectorConfig(environment).model).toMatchObject({ version: '2026-09-18-seg', threads: 2 });
  });
  it.each(['disable', 'require', 'no-verify'])('refuses remote TLS mode %s', (mode) => {
    expect(() =>
      detectorConfig({ ...environment, DATABASE_URL: environment.DATABASE_URL.replace('verify-full', mode) }),
    ).toThrow('verify TLS');
  });
  it.each(['sslmode=disable', 'host=other.example', 'ssl=false', 'sslrootcert=/tmp/ca.pem'])(
    'refuses ambiguous or unsupported connection option %s',
    (option) => {
      expect(() => detectorConfig({ ...environment, DATABASE_URL: `${environment.DATABASE_URL}&${option}` })).toThrow(
        'verify TLS',
      );
    },
  );
  it('refuses process-wide certificate verification bypass', () => {
    expect(() => detectorConfig({ ...environment, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow('verify TLS');
  });
  it('allows an application name without changing the TLS contract', () => {
    expect(
      detectorConfig({ ...environment, DATABASE_URL: `${environment.DATABASE_URL}&application_name=detector` })
        .databaseUrl,
    ).toContain('application_name=detector');
  });
  it.each(['localhost', '127.0.0.1', '[::1]'])('allows local development at %s', (host) => {
    expect(
      detectorConfig({ ...environment, DATABASE_URL: `postgresql://worker:secret@${host}/boardsesh` }).databaseUrl,
    ).toContain(host);
  });
  it.each(['localhost', '127.0.0.1', '[::1]'])('preserves explicit TLS verification at %s', (host) => {
    const databaseUrl = `postgresql://worker:secret@${host}/boardsesh?sslmode=verify-full`;
    expect(detectorConfig({ ...environment, DATABASE_URL: databaseUrl }).databaseUrl).toBe(databaseUrl);
  });
  it('refuses plaintext photo storage and invalid ports', () => {
    expect(() => detectorConfig({ ...environment, PRIVATE_AWS_ENDPOINT_URL_S3: 'http://storage.example' })).toThrow(
      'HTTPS',
    );
    expect(() => detectorConfig({ ...environment, HEALTH_PORT: 'NaN' })).toThrow('health port');
  });
});
