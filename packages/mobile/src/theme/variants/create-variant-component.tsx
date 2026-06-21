import { type ComponentType } from 'react';
import { useTheme } from '../../providers/theme-provider';
import type { UiVariant } from '../resolve-ui-variant';

/**
 * Build a single public component from one implementation per UI variant, with
 * an identical prop API. Replaces the hand-written
 * `variant === 'material' ? <XMaterial/> : <XGlass/>` router so every swap site
 * is uniform and exhaustive (`Record<UiVariant, …>` — a new variant can't
 * compile until each component supplies an implementation).
 *
 * The chosen implementation is rendered as JSX (`<Impl {...props} />`), NOT
 * called as a function. This is load-bearing: rendering gives each variant its
 * OWN fiber and hook list, so a live variant flip (the user toggling the setting)
 * unmounts one subtree and mounts the other. Calling `Impl(props)` instead would
 * run the impl's hooks in this wrapper's slot list — and the two impls routinely
 * have different hook counts (e.g. the glass impl runs an extra animation effect),
 * which crashes with "rendered fewer/more hooks than during the previous render".
 *
 * In React 19 `ref` is a normal prop, so it forwards through `{...props}` for any
 * impl whose props type includes it — no `forwardRef` needed. Only wrap
 * components whose two impls are already fully-distinct subtrees: a router flips
 * the element TYPE on a variant change, so any `useState` / shared value / scroll
 * / focus held ABOVE the variant split is lost on flip. Keep those as in-body
 * `selectByVariant` so the stateful shell stays mounted. See ./README.md.
 */
export function createVariantComponent<P extends object>(
  name: string,
  impls: Record<UiVariant, ComponentType<P>>,
): ComponentType<P> {
  function VariantComponent(props: P) {
    const Impl = impls[useTheme().variant];
    return <Impl {...props} />;
  }
  VariantComponent.displayName = name;
  return VariantComponent;
}
