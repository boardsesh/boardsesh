/**
 * The shared UI for `/build-plans*`.
 *
 * Everything on this surface — landing, configurator, preview, orders, order,
 * licence — is built from these. If a page needs a panel, a heading, a figure
 * or a status, it comes from here rather than from a one-off `sx` block, so the
 * four pages cannot drift into four design systems again.
 *
 * The visual system these implement is documented in `docs/build-plans-design.md`.
 */
export { default as PageFrame, type PageFrameProps } from './page-frame';
export { default as PageSection, type PageSectionProps } from './section';
export { default as SectionCard, type SectionCardProps } from './section-card';
export { default as StepHeading, type StepHeadingProps } from './step-heading';
export { default as KeyValueList, type KeyValueItem, type KeyValueListProps } from './key-value-list';
export { default as PriceTag, type PriceTagProps } from './price-tag';
export { default as StatusChip, buildPlanStatusTone, type BuildPlanStatus, type StatusChipProps } from './status-chip';
export { default as SplitLayout, type SplitLayoutProps } from './split-layout';
export { default as FieldGrid, type FieldGridProps } from './field-grid';
export { default as PreviewGallery, type PreviewImage, type PreviewGalleryProps } from './preview-gallery';
export { default as EmptyPanel, type EmptyPanelProps } from './empty-panel';
