import 'server-only';
import { browserConsumerFacade } from './browser-consumers.server';
import { issueNativeBrowserHandoffToken } from './native-browser-handoff-token.server';
import type { AdmittedBrowserSelection } from './presented-browser-selection.server';
import { readNativeProviderSigninContext } from './native-provider-signin-context.server';
import type { NativeProviderSigninContext } from '@boardsesh/auth-protocol/native-browser-handoff-v1';

function selectionKey(selection: AdmittedBrowserSelection): string {
  return JSON.stringify([selection.bindingToken, selection.cursor, selection.session, selection.actor]);
}

export function createSelectedNativeBrowserHandoff(dependencies: {
  readonly observe: typeof browserConsumerFacade.observe;
  readonly issue: typeof issueNativeBrowserHandoffToken;
  readonly readCreationContext?: (
    cookieHeader: string | null,
    selection: AdmittedBrowserSelection,
    returnUrl: string,
  ) => Promise<NativeProviderSigninContext | undefined>;
}) {
  return async (
    cookieHeader: string | null,
    attribution?: { readonly returnUrl: string },
  ): Promise<
    | { readonly status: 'legacy' }
    | { readonly status: 'admitted'; readonly transferToken: string }
    | { readonly status: 'denied' | 'conflict' | 'unavailable' }
  > => {
    try {
      const selection = await dependencies.observe(cookieHeader);
      if (selection.status === 'legacy') return { status: 'legacy' };
      if (selection.status !== 'admitted')
        return {
          status: selection.status === 'unavailable' || selection.status === 'conflict' ? selection.status : 'denied',
        };
      const captured = structuredClone(selection);
      const expected = selectionKey(captured);
      const providerSignin =
        attribution && dependencies.readCreationContext
          ? await dependencies.readCreationContext(cookieHeader, captured, attribution.returnUrl)
          : undefined;
      const issued = providerSignin
        ? await dependencies.issue(captured, { providerSignin })
        : await dependencies.issue(captured);
      if (issued.status !== 'admitted') return { status: issued.status };
      const current = await dependencies.observe(cookieHeader);
      if (current.status === 'unavailable') return { status: 'unavailable' };
      if (current.status !== 'admitted' || selectionKey(current) !== expected) return { status: 'conflict' };
      if (Date.parse(issued.expiresAt) <= Date.now()) return { status: 'denied' };
      return { status: 'admitted', transferToken: issued.token };
    } catch {
      return { status: 'unavailable' };
    }
  };
}

export const selectedNativeBrowserHandoff = createSelectedNativeBrowserHandoff({
  observe: browserConsumerFacade.observe,
  issue: issueNativeBrowserHandoffToken,
  readCreationContext: (cookieHeader, selection, returnUrl) =>
    readNativeProviderSigninContext(cookieHeader, selection, returnUrl, { secret: process.env.NEXTAUTH_SECRET ?? '' }),
});
