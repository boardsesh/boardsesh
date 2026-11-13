import 'server-only';
import { browserConsumerFacade } from './browser-consumers.server';
import { issueNativeBrowserHandoffToken } from './native-browser-handoff-token.server';
import type { AdmittedBrowserSelection } from './presented-browser-selection.server';

function selectionKey(selection: AdmittedBrowserSelection): string {
  return JSON.stringify([selection.bindingToken, selection.cursor, selection.session, selection.actor]);
}

export function createSelectedNativeBrowserHandoff(dependencies: {
  readonly observe: typeof browserConsumerFacade.observe;
  readonly issue: typeof issueNativeBrowserHandoffToken;
}) {
  return async (
    cookieHeader: string | null,
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
      const expected = selectionKey(selection);
      const issued = await dependencies.issue(selection);
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
});
