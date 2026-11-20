import React from 'react';
import type { Locale } from '@/app/lib/i18n/config';
import { buildDirectoryHref, type DirectoryFacet, type DirectoryQuery } from './directory-facets';
import GymPlaceSearch from './gym-place-search';

/** The GET form and initial results remain server-rendered; suggestions enhance it. */
export type GymDirectorySearchFormProps = {
  facet: DirectoryFacet;
  query: DirectoryQuery;
  locale: Locale;
  focusSearch?: boolean;
  /** The board filter panel; rendered inside the same GET form. */
  children?: React.ReactNode;
  /** A secondary client action beside the submit button. */
  actions?: React.ReactNode;
};

export default function GymDirectorySearchForm(props: GymDirectorySearchFormProps) {
  // A server navigation resets draft text and any outstanding suggestions.
  return <GymPlaceSearch key={buildDirectoryHref(props.facet, props.query, props.query.page)} {...props} />;
}
