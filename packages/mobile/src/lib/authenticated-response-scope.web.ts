import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { captureBrowserResponseCurrent } from './browser-response-admission.web';
import {
  captureAuthCredentialGeneration,
  isAuthCredentialGenerationCurrent,
  isRequiredBrowserDispatch,
} from './auth-store.web';

/** An actual selected response supplies its ORIGINAL lease guard. A later
 * response or caller-supplied metadata cannot replace that receipt. */
export function captureAuthenticatedResponse(response: Response): () => void {
  const original = captureBrowserResponseCurrent(response);
  if (original) {
    original();
    return original;
  }
  if (isRequiredBrowserDispatch()) throw new BrowserBackendConsumerError('unavailable');
  const generation = captureAuthCredentialGeneration();
  return () => {
    if (isRequiredBrowserDispatch() || !isAuthCredentialGenerationCurrent(generation))
      throw new BrowserBackendConsumerError('superseded');
  };
}
