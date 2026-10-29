import { gql } from 'graphql-request';
import type { ProjectNewsEmailConsent, SetProjectNewsEmailConsentInput } from '@boardsesh/shared-schema';

const PROJECT_NEWS_EMAIL_CONSENT_FIELDS = gql`
  fragment ProjectNewsEmailConsentFields on ProjectNewsEmailConsent {
    subscribed
    decidedAt
  }
`;

/** The signed-in climber's "Email me project news" answer. Never answered reads as off. */
export const GET_MY_PROJECT_NEWS_EMAIL_CONSENT = gql`
  query GetMyProjectNewsEmailConsent {
    myProjectNewsEmailConsent {
      ...ProjectNewsEmailConsentFields
    }
  }
  ${PROJECT_NEWS_EMAIL_CONSENT_FIELDS}
`;

export type GetMyProjectNewsEmailConsentResponse = { myProjectNewsEmailConsent: ProjectNewsEmailConsent };

export const SET_PROJECT_NEWS_EMAIL_CONSENT = gql`
  mutation SetProjectNewsEmailConsent($input: SetProjectNewsEmailConsentInput!) {
    setProjectNewsEmailConsent(input: $input) {
      ...ProjectNewsEmailConsentFields
    }
  }
  ${PROJECT_NEWS_EMAIL_CONSENT_FIELDS}
`;

export type SetProjectNewsEmailConsentVariables = { input: SetProjectNewsEmailConsentInput };
export type SetProjectNewsEmailConsentResponse = { setProjectNewsEmailConsent: ProjectNewsEmailConsent };
