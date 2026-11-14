/** Native retains its existing credential, query keys and caller behavior. */
export function captureHttpRequestScope(_label?: string | null): undefined {
  return undefined;
}
export function assertCurrentHttpResult(_scope: string | undefined, _result: unknown): void {}
export function isCurrentHttpView(_scope: string | undefined): boolean {
  return true;
}
export function httpScopeQueryKey<Key extends readonly unknown[]>(key: Key, _scope?: string | null): Key {
  return key;
}
