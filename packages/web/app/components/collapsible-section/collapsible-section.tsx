'use client';

import React, { useEffect, useRef, useState } from 'react';
import styles from './collapsible-section.module.css';

export type CollapsibleSectionConfig = {
  key: string;
  label: React.ReactNode;
  title: React.ReactNode;
  defaultSummary: string;
  /** Optional dynamic summary parts. When omitted or it returns [], falls back to defaultSummary. */
  getSummary?: () => string[];
  content: React.ReactNode;
  /** Optional action slot rendered on the right side of the header when expanded. */
  action?: React.ReactNode;
  /** When true, content is only mounted while this section is the active one. */
  lazy?: boolean;
  /** When true, this section should be the initially active one (overrides defaultActiveKey). */
  defaultActive?: boolean;
  /**
   * When true, this section is rendered as always-expanded — independent
   * of the single-active accordion state. The user can't collapse it. Use
   * for sections where the content is the point of opening the drawer
   * (e.g. Beta videos, Similar climbs) and the user shouldn't have to
   * tap once to see it.
   */
  keepExpanded?: boolean;
  /** When true, removes the inner padding around the expanded content. */
  flush?: boolean;
};

type CollapsibleSectionProps = {
  sections: CollapsibleSectionConfig[];
  defaultActiveKey?: string;
  /** When provided, forces this section to be active (e.g. for a guided tour). */
  forcedActiveKey?: string | null;
  /** Use a denser collapsed layout on short desktop viewports. */
  compactDesktopGrid?: boolean;
};

const EXPAND_SCROLL_DELAY_MS = 275;

function findScrollableParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  let fallback: HTMLElement | null = null;
  while (parent) {
    const { overflowY } = window.getComputedStyle(parent);
    const canScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    if (canScroll) {
      if (parent.scrollHeight > parent.clientHeight) {
        return parent;
      }
      fallback ??= parent;
    }
    parent = parent.parentElement;
  }
  return fallback;
}

function scrollSectionIntoView(sectionEl: HTMLElement): void {
  const scrollParent = findScrollableParent(sectionEl);
  if (!scrollParent) {
    sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    return;
  }

  const sectionTop = sectionEl.getBoundingClientRect().top;
  const parentTop = scrollParent.getBoundingClientRect().top;
  scrollParent.scrollTo({
    top: scrollParent.scrollTop + sectionTop - parentTop,
    behavior: 'smooth',
  });
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  sections,
  defaultActiveKey,
  forcedActiveKey,
  compactDesktopGrid = false,
}) => {
  const sectionDefaultActive = sections.find((s) => s.defaultActive);
  const initialActiveKey = sectionDefaultActive?.key ?? defaultActiveKey ?? null;
  const [activeKey, setActiveKey] = useState<string | null>(initialActiveKey);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pendingScrollKeyRef = useRef<string | null>(null);
  // Preserve the initial default so we can restore it if we transition back
  // from controlled (forcedActiveKey set) to uncontrolled mode.
  const initialActiveKeyRef = useRef(initialActiveKey);
  // Track whether we've ever seen a non-empty sections array — sections can
  // arrive on a later render (deferred below-fold mount in the play drawer),
  // and we need to honour their defaultActive once they show up.
  const initializedRef = useRef(sections.length > 0);

  useEffect(() => {
    if (initializedRef.current) return;
    if (sections.length === 0) return;
    const resolvedKey = sections.find((s) => s.defaultActive)?.key ?? defaultActiveKey ?? null;
    initialActiveKeyRef.current = resolvedKey;
    setActiveKey(resolvedKey);
    initializedRef.current = true;
  }, [sections, defaultActiveKey]);

  useEffect(() => {
    if (forcedActiveKey !== undefined) {
      setActiveKey(forcedActiveKey);
    } else {
      // Transitioned back to uncontrolled — snap back to the original default
      // so the last forced value doesn't leak into user-driven mode.
      setActiveKey(initialActiveKeyRef.current);
    }
  }, [forcedActiveKey]);

  const effectiveActiveKey = forcedActiveKey !== undefined ? forcedActiveKey : activeKey;
  const interactionDisabled = forcedActiveKey !== undefined;

  useEffect(() => {
    const key = pendingScrollKeyRef.current;
    if (!key || effectiveActiveKey !== key) return;
    const sectionEl = sectionRefs.current[key];
    if (!sectionEl) return;

    let timeout: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      scrollSectionIntoView(sectionEl);
      timeout = window.setTimeout(() => {
        scrollSectionIntoView(sectionEl);
        if (pendingScrollKeyRef.current === key) {
          pendingScrollKeyRef.current = null;
        }
      }, EXPAND_SCROLL_DELAY_MS);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
      if (pendingScrollKeyRef.current === key) {
        pendingScrollKeyRef.current = null;
      }
    };
  }, [effectiveActiveKey]);

  const openSection = (key: string) => {
    pendingScrollKeyRef.current = key;
    setActiveKey(key);
  };

  return (
    <div className={`${styles.steppedContainer} ${compactDesktopGrid ? styles.steppedContainerCompactDesktop : ''}`}>
      {sections.map((section) => {
        // keepExpanded sections are treated as permanently-active. They
        // don't participate in the single-active accordion state machine,
        // so they sit alongside whatever the user has expanded without
        // collapsing it.
        const isActive = section.keepExpanded || effectiveActiveKey === section.key;
        const summaryParts = section.getSummary?.() ?? [];
        const summaryText = summaryParts.length > 0 ? summaryParts.join(' \u00B7 ') : section.defaultSummary;

        const shouldRenderContent = section.lazy ? isActive : true;

        const headerClickable = !interactionDisabled && !section.keepExpanded;

        // a11y: header advertises its accordion state so screen readers can
        // announce expanded/collapsed correctly. keepExpanded sections set
        // aria-disabled so AT users hear "this can't be collapsed" instead
        // of expecting an interaction the click handler silently drops.
        const headerRole = headerClickable ? 'button' : undefined;
        const headerTabIndex = headerClickable ? 0 : undefined;
        const headerAriaExpanded = section.keepExpanded ? true : isActive;
        const headerAriaDisabled = section.keepExpanded ? true : undefined;

        return (
          <div
            key={section.key}
            ref={(node) => {
              sectionRefs.current[section.key] = node;
            }}
            className={`${styles.sectionCard} ${isActive ? styles.sectionCardActive : ''}`}
            {...(!isActive && headerClickable ? { onClick: () => openSection(section.key) } : {})}
          >
            <div
              role={headerRole}
              tabIndex={headerTabIndex}
              aria-expanded={headerAriaExpanded}
              aria-disabled={headerAriaDisabled}
              className={`${styles.collapsedRow} ${isActive ? styles.collapsedRowActive : ''}`}
              {...(isActive && headerClickable ? { onClick: () => setActiveKey(null) } : {})}
            >
              {isActive && section.action ? (
                <span className={styles.collapsedTitleWithAction}>
                  <span className={styles.collapsedLabel}>{section.title}</span>
                  <span className={styles.headerAction} onClick={(event) => event.stopPropagation()}>
                    {section.action}
                  </span>
                </span>
              ) : (
                <>
                  <span className={styles.collapsedLabel}>{isActive ? section.title : section.label}</span>
                  <span className={`${styles.collapsedSummary} ${isActive ? styles.collapsedSummaryHidden : ''}`}>
                    {summaryText}
                  </span>
                </>
              )}
            </div>
            <div className={`${styles.expandableContent} ${isActive ? styles.expandableContentOpen : ''}`}>
              <div className={styles.expandableInner}>
                <div className={section.flush ? styles.expandableInnerFlush : styles.expandableInnerPadding}>
                  {shouldRenderContent ? section.content : null}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default CollapsibleSection;
