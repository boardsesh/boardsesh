import { describe, expect, it } from 'vitest';
import { tutorialDemoEnvironment } from './demo';

const ports = { postgres: 15433, redis: 16380, s3: 15001, backend: 18089 };

describe('isolated instructional demo environment', () => {
  it('replaces production resources and drops inherited credentials and side-effect integrations', () => {
    const inherited = {
      PATH: '/test/bin',
      HOME: '/test/home',
      DATABASE_URL: 'postgres://production',
      READ_REPLICA_URL: 'postgres://replica',
      AWS_ACCESS_KEY_ID: 'production-aws',
      PRIVATE_AWS_SECRET_ACCESS_KEY: 'production-r2',
      MEDIA_S3_BUCKET_NAME: 'production-media',
      SMTP_PASSWORD: 'production-mail',
      SENTRY_DSN: 'production-sentry',
      POSTHOG_API_KEY: 'production-analytics',
      NEXTAUTH_SECRET: 'production-auth',
      ANDROID_SDK_ROOT: '/sdk',
    };
    const configured = tutorialDemoEnvironment(ports, inherited);
    expect(configured.PATH).toBe(inherited.PATH);
    expect(configured.ANDROID_SDK_ROOT).toBe('/sdk');
    expect(new URL(configured.DATABASE_URL!).pathname).toBe('/boardsesh_tutorial');
    expect(configured.READ_REPLICA_URL).toBe('');
    expect(configured.PRIVATE_AWS_SECRET_ACCESS_KEY).toBe('tutorial-local');
    for (const removed of [
      'AWS_ACCESS_KEY_ID',
      'MEDIA_S3_BUCKET_NAME',
      'SMTP_PASSWORD',
      'SENTRY_DSN',
      'POSTHOG_API_KEY',
    ])
      expect(configured[removed]).toBeUndefined();
  });

  it('uses the same loopback backend for REST, WebSockets, storage and emulator forwarding', () => {
    const configured = tutorialDemoEnvironment(ports, {});
    expect(configured.EXPO_PUBLIC_BACKEND_URL).toBe('http://127.0.0.1:18089');
    expect(configured.EXPO_PUBLIC_WS_URL).toBe('ws://127.0.0.1:18089/graphql');
    expect(configured.PRIVATE_AWS_ENDPOINT_URL).toBe('http://127.0.0.1:15001');
    expect(configured.TUTORIAL_S3_PORT).toBe('15001');
    expect(configured.PRIVATE_S3_FORCE_PATH_STYLE).toBe('true');
    expect(configured.PRIVATE_DISABLE_ACL).toBe('true');
    expect(configured.DOTENV_CONFIG_PATH).toBe('/dev/null');
    expect(configured.BOARDSESH_TUTORIAL_DEMO).toBe('1');
  });

  it('rejects invalid or colliding ports before any process can start', () => {
    expect(() => tutorialDemoEnvironment({ ...ports, postgres: 0 }, {})).toThrow('distinct valid local ports');
    expect(() => tutorialDemoEnvironment({ ...ports, backend: ports.redis }, {})).toThrow('distinct valid local ports');
    expect(() => tutorialDemoEnvironment({ ...ports, s3: 65536 }, {})).toThrow('distinct valid local ports');
  });
});
