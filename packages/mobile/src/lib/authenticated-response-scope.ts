/** Native retains its existing response and credential policy. */
export function captureAuthenticatedResponse(_response: Response): () => void {
  return () => {};
}
