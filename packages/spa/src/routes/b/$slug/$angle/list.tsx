import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Chip from '@mui/material/Chip'
import TextField from '@mui/material/TextField'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import Button from '@mui/material/Button'
import InputAdornment from '@mui/material/InputAdornment'
import SearchIcon from '@mui/icons-material/Search'
import { useState, useCallback } from 'react'
import { graphqlClient } from '@/lib/graphql-client'
import { SEARCH_CLIMBS } from '@/lib/graphql-queries'
import { useBoardConfig } from '@/lib/board-context'
import type { ClimbSearchResult, Climb } from '@/lib/types'

type SortBy = 'ascents' | 'difficulty' | 'name' | 'quality'
type SortOrder = 'asc' | 'desc'

interface SearchFilters {
  name: string
  sortBy: SortBy
  sortOrder: SortOrder
  minAscents: number
  page: number
  pageSize: number
}

const DEFAULT_FILTERS: SearchFilters = {
  name: '',
  sortBy: 'ascents',
  sortOrder: 'desc',
  minAscents: 0,
  page: 0,
  pageSize: 30,
}

export const Route = createFileRoute('/b/$slug/$angle/list')({
  component: ClimbListPage,
})

function ClimbListPage() {
  const board = useBoardConfig()
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS)
  const [searchInput, setSearchInput] = useState('')

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['searchClimbs', board.slug, board.angle, filters],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        searchClimbs: ClimbSearchResult
      }>(SEARCH_CLIMBS, {
        input: {
          boardName: board.boardType,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          angle: board.angle,
          page: filters.page,
          pageSize: filters.pageSize,
          sortBy: filters.sortBy,
          sortOrder: filters.sortOrder,
          name: filters.name || undefined,
          minAscents: filters.minAscents || undefined,
        },
      })
      return result.searchClimbs
    },
  })

  const handleSearch = useCallback(() => {
    setFilters((prev) => ({ ...prev, name: searchInput, page: 0 }))
  }, [searchInput])

  const handleSortChange = useCallback((sortBy: SortBy) => {
    setFilters((prev) => ({ ...prev, sortBy, page: 0 }))
  }, [])

  const handleSortOrderChange = useCallback((sortOrder: SortOrder) => {
    setFilters((prev) => ({ ...prev, sortOrder, page: 0 }))
  }, [])

  const handleLoadMore = useCallback(() => {
    setFilters((prev) => ({ ...prev, page: prev.page + 1 }))
  }, [])

  const climbs = data?.climbs ?? []
  const hasMore = data?.hasMore ?? false

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', width: '100%' }}>
      {/* Header */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5" component="h1" gutterBottom>
          {board.name}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {board.boardType} at {board.angle} degrees
        </Typography>
      </Box>

      {/* Search and filters */}
      <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          placeholder="Search climbs..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ flex: 1, minWidth: 200 }}
        />

        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Sort by</InputLabel>
          <Select
            value={filters.sortBy}
            label="Sort by"
            onChange={(e) => handleSortChange(e.target.value as SortBy)}
          >
            <MenuItem value="ascents">Ascents</MenuItem>
            <MenuItem value="difficulty">Difficulty</MenuItem>
            <MenuItem value="quality">Quality</MenuItem>
            <MenuItem value="name">Name</MenuItem>
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 100 }}>
          <InputLabel>Order</InputLabel>
          <Select
            value={filters.sortOrder}
            label="Order"
            onChange={(e) => handleSortOrderChange(e.target.value as SortOrder)}
          >
            <MenuItem value="desc">Desc</MenuItem>
            <MenuItem value="asc">Asc</MenuItem>
          </Select>
        </FormControl>
      </Box>

      {/* Results */}
      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : climbs.length === 0 ? (
        <Box sx={{ py: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            No climbs found. Try adjusting your filters.
          </Typography>
        </Box>
      ) : (
        <>
          <List disablePadding>
            {climbs.map((climb) => (
              <ClimbListItem
                key={climb.uuid}
                climb={climb}
                slug={board.slug}
                angle={board.angle}
              />
            ))}
          </List>

          {/* Load more */}
          {hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <Button
                variant="outlined"
                onClick={handleLoadMore}
                disabled={isFetching}
              >
                {isFetching ? 'Loading...' : 'Load More'}
              </Button>
            </Box>
          )}

          {data?.totalCount != null && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: 'center', py: 1 }}
            >
              Showing {climbs.length} of {data.totalCount} climbs
            </Typography>
          )}
        </>
      )}
    </Box>
  )
}

function ClimbListItem({
  climb,
  slug,
  angle,
}: {
  climb: Climb
  slug: string
  angle: number
}) {
  return (
    <Link
      to="/b/$slug/$angle/view/$climbUuid"
      params={{ slug, angle: String(angle), climbUuid: climb.uuid }}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <ListItemButton
        sx={{
          borderRadius: 1,
          mb: 0.5,
          '&:hover': {
            bgcolor: 'action.hover',
          },
        }}
      >
        <ListItemText
          primary={climb.name}
          secondary={`by ${climb.setter_username}`}
          slotProps={{
            primary: { noWrap: true },
          }}
        />
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 1, flexShrink: 0 }}>
          <Chip
            label={climb.difficulty}
            size="small"
            color="primary"
            variant="outlined"
          />
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40, textAlign: 'right' }}>
            {climb.ascensionist_count} sends
          </Typography>
        </Box>
      </ListItemButton>
    </Link>
  )
}
