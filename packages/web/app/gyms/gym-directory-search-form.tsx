import React from 'react';
import type { Locale } from '@/app/lib/i18n/config';
import type { DirectoryFacet, DirectoryQuery } from './directory-facets';
import GymPlaceSearch from './gym-place-search';

/** The GET form and initial results remain server-rendered; suggestions enhance it. */
export default function GymDirectorySearchForm(props: {
  facet: DirectoryFacet;
  query: DirectoryQuery;
  locale: Locale;
}) {
  // A server navigation resets draft text and any outstanding suggestions.
  return <GymPlaceSearch key={JSON.stringify(props.query)} {...props} />;
}
