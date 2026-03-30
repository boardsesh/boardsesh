import { createContext, useContext, type ReactNode } from 'react'

/**
 * Board configuration resolved from the URL slug.
 * This maps to the UserBoard entity returned by the boardBySlug GraphQL query.
 */
export interface BoardConfig {
  /** The board entity UUID */
  uuid: string
  /** URL slug for this board */
  slug: string
  /** Board type: kilter, tension, moonboard */
  boardType: string
  /** Layout ID */
  layoutId: number
  /** Size ID */
  sizeId: number
  /** Comma-separated set IDs */
  setIds: string
  /** Board display name */
  name: string
  /** Current angle from the URL */
  angle: number
  /** Whether the board's angle is physically adjustable */
  isAngleAdjustable: boolean
  /** Human-readable layout name */
  layoutName?: string | null
  /** Human-readable size name */
  sizeName?: string | null
  /** Human-readable size description */
  sizeDescription?: string | null
  /** Human-readable set names */
  setNames?: string[] | null
}

const BoardContext = createContext<BoardConfig | null>(null)

export function BoardProvider({
  config,
  children,
}: {
  config: BoardConfig
  children: ReactNode
}) {
  return (
    <BoardContext.Provider value={config}>{children}</BoardContext.Provider>
  )
}

/**
 * Access the current board configuration.
 * Must be used within a board layout route.
 */
export function useBoardConfig(): BoardConfig {
  const ctx = useContext(BoardContext)
  if (!ctx) {
    throw new Error('useBoardConfig must be used within a BoardProvider')
  }
  return ctx
}
