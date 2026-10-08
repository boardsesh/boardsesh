import { subscribeAuthCredentialGenerationChanges } from './auth-store';
import { invalidateConsentAccount } from './consent-state';

subscribeAuthCredentialGenerationChanges(invalidateConsentAccount);
