import { describe, expect, it } from 'vite-plus/test';
import { PARTNER_DEVELOPER_TERMS_VERSION } from '@boardsesh/auth-protocol/partner-oauth';
import type { OAuthClient } from '@boardsesh/shared-schema';
import {
  EMPTY_APP_FORM,
  formFromApp,
  isEmptyUpdate,
  missingAppFormFields,
  parseRedirectUris,
  toCreateInput,
  toUpdateInput,
} from '../app-form';

const APP: OAuthClient = {
  clientId: 'bsk_planner',
  name: 'Hangboard Planner',
  publisherName: 'Planner Labs',
  homepageUrl: 'https://planner.example/',
  privacyPolicyUrl: 'https://planner.example/privacy',
  applicationType: 'WEB',
  tokenEndpointAuthMethod: 'CLIENT_SECRET_POST',
  redirectUris: ['https://planner.example/cb', 'https://planner.example/cb2'],
  createdAt: '2026-11-10T00:00:00.000Z',
  suspendedAt: null,
  suspensionReason: null,
  maxActiveConnections: 25,
  maxNewConnectionsPerDay: 20,
  activeConnections: 3,
};

describe('the register and edit form', () => {
  it('reads one redirect URI per line, trimmed, without blank lines', () => {
    expect(parseRedirectUris(' https://a.example/cb \r\n\n  \ncom.example.app:/oauth\n')).toEqual([
      'https://a.example/cb',
      'com.example.app:/oauth',
    ]);
  });

  it('names the fields the form must not send empty, and asks for the terms only when registering', () => {
    expect(missingAppFormFields(EMPTY_APP_FORM, { registering: true })).toEqual([
      'name',
      'publisherName',
      'privacyPolicyUrl',
      'redirectUris',
      'acceptedTerms',
    ]);
    expect(missingAppFormFields(EMPTY_APP_FORM, { registering: false })).toEqual([
      'name',
      'publisherName',
      'privacyPolicyUrl',
      'redirectUris',
    ]);
    expect(missingAppFormFields(formFromApp(APP), { registering: false })).toEqual([]);
    expect(missingAppFormFields({ ...formFromApp(APP), acceptedTerms: false }, { registering: true })).toEqual([
      'acceptedTerms',
    ]);
  });

  it('builds a create input: a public app sends no secret method, and a blank homepage is left out', () => {
    const input = toCreateInput({
      ...EMPTY_APP_FORM,
      name: ' Crimp Lab ',
      publisherName: ' Crimp Labs ',
      privacyPolicyUrl: 'https://crimp.example/privacy',
      applicationType: 'NATIVE',
      clientType: 'public',
      secretMethod: 'CLIENT_SECRET_POST',
      redirectUris: 'com.example.crimp:/oauth/boardsesh\nhttp://127.0.0.1/callback',
    });
    expect(input).toEqual({
      name: 'Crimp Lab',
      publisherName: 'Crimp Labs',
      privacyPolicyUrl: 'https://crimp.example/privacy',
      applicationType: 'NATIVE',
      tokenEndpointAuthMethod: 'NONE',
      redirectUris: ['com.example.crimp:/oauth/boardsesh', 'http://127.0.0.1/callback'],
      // The version this page shows; the server refuses any other.
      acceptedTermsVersion: PARTNER_DEVELOPER_TERMS_VERSION,
    });
    expect(toCreateInput({ ...EMPTY_APP_FORM, clientType: 'confidential' }).tokenEndpointAuthMethod).toBe(
      'CLIENT_SECRET_BASIC',
    );
  });

  it('round-trips an app and sends nothing when nothing changed', () => {
    const state = formFromApp(APP);
    expect(state).toMatchObject({ clientType: 'confidential', secretMethod: 'CLIENT_SECRET_POST' });
    const input = toUpdateInput(APP, state);
    expect(input).toEqual({ clientId: 'bsk_planner' });
    expect(isEmptyUpdate(input)).toBe(true);
  });

  it('sends only what changed, clears a homepage with null, and never the app or client type', () => {
    const input = toUpdateInput(APP, {
      ...formFromApp(APP),
      publisherName: 'Planner Labs Ltd',
      homepageUrl: '   ',
      redirectUris: 'https://planner.example/cb',
      applicationType: 'NATIVE',
      clientType: 'public',
    });
    expect(input).toEqual({
      clientId: 'bsk_planner',
      publisherName: 'Planner Labs Ltd',
      homepageUrl: null,
      redirectUris: ['https://planner.example/cb'],
    });
  });
});
