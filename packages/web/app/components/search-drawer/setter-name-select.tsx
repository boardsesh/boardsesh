'use client';

import React, { useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import { useUISearchParams } from '../queue-control/ui-searchparams-provider';
import { useSearchData } from '../graphql-queue';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { constructSetterStatsUrl } from '@/app/lib/url-utils';

interface SetterStat {
  setter_username: string;
  climb_count: number;
}

interface SetterOption {
  value: string;
  label: string;
  count: number;
}

const fetcher = (url: string) => fetch(url).then((res) => res.json());

const MIN_SEARCH_LENGTH = 2; // Only search when user has typed at least 2 characters

const SetterNameSelect = () => {
  const { uiSearchParams, updateFilters } = useUISearchParams();
  const { parsedParams } = useSearchData();
  const [searchValue, setSearchValue] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  // Fetch top setters when dropdown is open OR when user is searching
  const shouldFetch = isOpen || searchValue.length >= MIN_SEARCH_LENGTH;
  const isSearching = searchValue.length >= MIN_SEARCH_LENGTH;

  // Build API URL - with search query if searching, without if just showing top setters
  const apiUrl = shouldFetch
    ? constructSetterStatsUrl(parsedParams, isSearching ? searchValue : undefined)
    : null;

  // Fetch setter stats from the API
  const { data: setterStats, isLoading } = useQuery<SetterStat[]>({
    queryKey: ['setterStats', apiUrl],
    queryFn: () => fetcher(apiUrl!),
    enabled: !!apiUrl,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });

  // Map setter stats to Autocomplete options
  const options: SetterOption[] = React.useMemo(() => {
    if (!setterStats) return [];

    return setterStats.map(stat => ({
      value: stat.setter_username,
      label: `${stat.setter_username} (${stat.climb_count})`,
      count: stat.climb_count,
    }));
  }, [setterStats]);

  // Convert selected values (string[]) to option objects for Autocomplete
  const selectedOptions: SetterOption[] = React.useMemo(() => {
    return (uiSearchParams.settername || []).map(name => {
      const found = options.find(o => o.value === name);
      return found || { value: name, label: name, count: 0 };
    });
  }, [uiSearchParams.settername, options]);

  return (
    <Autocomplete
      multiple
      open={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      options={options}
      value={selectedOptions}
      onChange={(_, newValue) => updateFilters({ settername: newValue.map(v => v.value) })}
      onInputChange={(_, value, reason) => {
        if (reason !== 'reset') {
          setSearchValue(value);
        }
      }}
      inputValue={searchValue}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, value) => option.value === value.value}
      filterOptions={(x) => x} // Server-side filtering
      loading={isLoading}
      limitTags={2}
      noOptionsText={
        isLoading
          ? 'Loading...'
          : !isOpen && searchValue.length === 0
          ? 'Open dropdown to see setters'
          : 'No setters found'
      }
      sx={{ width: '100%' }}
      size="small"
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder={selectedOptions.length === 0 ? 'Search setters...' : ''}
          slotProps={{
            input: {
              ...params.InputProps,
              endAdornment: (
                <>
                  {isLoading ? <CircularProgress color="inherit" size={16} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            },
          }}
        />
      )}
    />
  );
};

export default SetterNameSelect;
