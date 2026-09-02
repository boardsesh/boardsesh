import React from 'react';

/**
 * Walk a server-component tree and await every async component in it, so the
 * result can go through `renderToString`.
 *
 * `renderToString` cannot suspend — hand it a tree with an unresolved async
 * server component anywhere inside and it throws "A component suspended while
 * responding to synchronous input" rather than rendering. Awaiting the page
 * function alone is not enough: it resolves only the outermost component, and
 * any async child it returned is still a promise at its first hook.
 *
 * `stopAt` holds back components the caller wants to observe by identity rather
 * than by output.
 */
function isAsyncComponent(type: unknown): boolean {
  return (
    typeof type === 'function' && (type as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction'
  );
}

export async function resolveServerTree(
  node: React.ReactNode,
  stopAt: ReadonlySet<unknown> = new Set(),
): Promise<React.ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolveServerTree(child, stopAt)));
  if (!React.isValidElement(node)) return node;

  const element = node as React.ReactElement<{ children?: React.ReactNode }>;
  if (isAsyncComponent(element.type) && !stopAt.has(element.type)) {
    const produced = await (element.type as (props: unknown) => Promise<unknown>)(element.props);
    if (React.isValidElement(produced)) return resolveServerTree(produced, stopAt);
    return (produced ?? null) as React.ReactNode;
  }

  const { children } = element.props;
  if (children === undefined) return element;
  return React.cloneElement(element, undefined, await resolveServerTree(children, stopAt));
}
