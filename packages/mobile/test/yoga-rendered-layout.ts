/**
 * Lays a rendered test tree out with Yoga, React Native's layout engine, for
 * suites that mock `react-native` wholesale and render each view as an element
 * carrying its flattened style in `data-style` (see `flatten-style.ts`).
 *
 * Views lay out by their styles; a leaf the suite sizes itself (a line of text,
 * an icon) takes the size `leafSize` answers. A layout style this does not
 * handle throws, so a test never passes on a layout it silently ignored.
 */
import Yoga, { Align, Direction, Edge, FlexDirection, Gutter, Justify, Wrap, type Node as YogaNode } from 'yoga-layout';

const ALIGN: Record<string, Align> = {
  center: Align.Center,
  'flex-start': Align.FlexStart,
  'flex-end': Align.FlexEnd,
  stretch: Align.Stretch,
};
const JUSTIFY: Record<string, Justify> = {
  center: Justify.Center,
  'flex-start': Justify.FlexStart,
  'flex-end': Justify.FlexEnd,
  'space-between': Justify.SpaceBetween,
};
const EDGES: Record<string, Edge> = {
  Top: Edge.Top,
  Bottom: Edge.Bottom,
  Horizontal: Edge.Horizontal,
  Vertical: Edge.Vertical,
  Start: Edge.Start,
  End: Edge.End,
};
const LAYOUT_KEY = /^(flex|align|justify|gap|rowGap|columnGap|padding|margin|width|height|min|max|position|top|left)/;

function styleOf(element: Element): Record<string, unknown> {
  return JSON.parse(element.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

function applyLayout(node: YogaNode, style: Record<string, unknown>) {
  for (const [key, value] of Object.entries(style)) {
    const edge = /^(padding|margin)(Top|Bottom|Horizontal|Vertical|Start|End)$/.exec(key);
    if (edge?.[1] && edge[2]) {
      const target = EDGES[edge[2]] as Edge;
      if (edge[1] === 'padding') node.setPadding(target, Number(value));
      else node.setMargin(target, Number(value));
    } else if (key === 'flexDirection') {
      node.setFlexDirection(value === 'row' ? FlexDirection.Row : FlexDirection.Column);
    } else if (key === 'flexWrap') {
      node.setFlexWrap(value === 'wrap' ? Wrap.Wrap : Wrap.NoWrap);
    } else if (key === 'alignItems') {
      node.setAlignItems(ALIGN[String(value)] as Align);
    } else if (key === 'justifyContent') {
      node.setJustifyContent(JUSTIFY[String(value)] as Justify);
    } else if (key === 'gap') {
      node.setGap(Gutter.All, Number(value));
    } else if (key === 'columnGap') {
      node.setGap(Gutter.Column, Number(value));
    } else if (key === 'rowGap') {
      node.setGap(Gutter.Row, Number(value));
    } else if (key === 'flex') {
      node.setFlex(Number(value));
    } else if (key === 'flexGrow') {
      node.setFlexGrow(Number(value));
    } else if (key === 'flexShrink') {
      node.setFlexShrink(Number(value));
    } else if (key === 'flexBasis') {
      node.setFlexBasis(Number(value));
    } else if (key === 'minWidth') {
      node.setMinWidth(value as number | `${number}%`);
    } else if (key === 'width') {
      node.setWidth(value as number | `${number}%`);
    } else if (key === 'height') {
      node.setHeight(value as number | `${number}%`);
    } else if (key === 'minHeight') {
      node.setMinHeight(value as number | `${number}%`);
    } else if (LAYOUT_KEY.test(key)) {
      throw new Error(`yoga-rendered-layout does not lay out "${key}"`);
    }
  }
}

export type RenderedBox = { top: number; left: number; bottom: number; height: number };

/** Lays `root` out at `width`. Answers each element's box on the page, and a `free` to call after. */
export function layOutRendered(
  root: Element,
  width: number,
  leafSize: (element: Element) => { width: number; height: number } | null,
): { boxOf: (element: Element) => RenderedBox; free: () => void } {
  const nodes = new Map<Element, YogaNode>();
  const build = (element: Element): YogaNode => {
    const node = Yoga.Node.create();
    nodes.set(element, node);
    applyLayout(node, styleOf(element));
    const leaf = leafSize(element);
    if (leaf) {
      node.setWidth(leaf.width);
      node.setHeight(leaf.height);
    } else {
      Array.from(element.children).forEach((child, index) => node.insertChild(build(child), index));
    }
    return node;
  };
  const rootNode = build(root);
  rootNode.setWidth(width);
  rootNode.calculateLayout(undefined, undefined, Direction.LTR);
  const boxOf = (element: Element): RenderedBox => {
    let top = 0;
    let left = 0;
    for (
      let current: Element | null = element;
      current && current !== root.parentElement;
      current = current.parentElement
    ) {
      const node = nodes.get(current);
      if (node) {
        top += node.getComputedTop();
        left += node.getComputedLeft();
      }
    }
    const node = nodes.get(element);
    if (!node) throw new Error('That element is not in the laid-out tree');
    return { top, left, bottom: top + node.getComputedHeight(), height: node.getComputedHeight() };
  };
  return { boxOf, free: () => rootNode.freeRecursive() };
}
