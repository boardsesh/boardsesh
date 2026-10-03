import { useEffect, useRef } from 'react';

/** Observer-only fallback: previous results never become a new search's cached answer. */
export function useRetainedQueryData<Result>(query: {
  data: Result | undefined;
  isSuccess: boolean;
  isPlaceholderData: boolean;
}): Result | undefined {
  const successfulResultRef = useRef<Result | undefined>(undefined);
  useEffect(() => {
    if (query.isSuccess && !query.isPlaceholderData) successfulResultRef.current = query.data;
  }, [query.data, query.isSuccess, query.isPlaceholderData]);
  return query.data ?? successfulResultRef.current;
}
