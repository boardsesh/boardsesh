/**
 * Exhaustiveness guard. Call it in the `default` of a `switch (variant)` (or
 * after an if-chain that handles every `UiVariant`) so adding a variant becomes
 * a compile error here: TypeScript only allows passing `never`, and an unhandled
 * case widens the argument to a real type, breaking the build at exactly the
 * spot that needs a decision.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${String(value)}`);
}
