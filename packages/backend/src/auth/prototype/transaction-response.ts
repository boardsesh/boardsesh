/** A provider can translate a thrown error into a Response before our transaction sees it. */
export class PrototypeResponseRollback extends Error {
  constructor(readonly response: Response) {
    super('Roll back the failed prototype auth request');
  }
}

export function rejectPrototypeServerFailure(response: Response): Response {
  if (response.status >= 500) throw new PrototypeResponseRollback(response);
  // OAuth invalid_grant responses may intentionally commit reuse revocation.
  return response;
}
