import { subscribeAuthTokenChanges } from './auth-store.web';
import { invalidateConsentAccount } from './consent-state';

subscribeAuthTokenChanges(() => invalidateConsentAccount());
