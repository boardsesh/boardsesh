import type { IncomingMessage, ServerResponse } from 'http'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { applyCorsHeaders } from './cors'

const OG_WIDTH = 1200
const OG_HEIGHT = 630

interface OgParams {
  type: 'climb' | 'profile' | 'session'
  id: string
  boardName: string
}

function parseParams(url: URL): OgParams | null {
  const type = url.searchParams.get('type')
  const id = url.searchParams.get('id')
  const boardName = url.searchParams.get('boardName')

  if (!type || !id || !boardName) {
    return null
  }

  if (type !== 'climb' && type !== 'profile' && type !== 'session') {
    return null
  }

  return { type, id, boardName }
}

function getTitle(params: OgParams): string {
  switch (params.type) {
    case 'climb':
      return 'Climb'
    case 'profile':
      return 'Climber Profile'
    case 'session':
      return 'Session'
  }
}

function getSubtitle(params: OgParams): string {
  const board = params.boardName.charAt(0).toUpperCase() + params.boardName.slice(1)
  return `${board} Board`
}

/**
 * Generates OG image markup for satori.
 * Uses plain objects with React-like structure that satori understands.
 */
function buildMarkup(params: OgParams): ReturnType<typeof Object> {
  const title = getTitle(params)
  const subtitle = getSubtitle(params)

  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0A0A0A',
        color: '#ffffff',
        fontFamily: 'Inter',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              fontSize: 72,
              fontWeight: 700,
              marginBottom: 16,
              color: '#ffffff',
            },
            children: 'Boardsesh',
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: 48,
              fontWeight: 600,
              marginBottom: 12,
              color: '#e0e0e0',
            },
            children: title,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: 32,
              color: '#888888',
            },
            children: subtitle,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: 24,
              color: '#666666',
              marginTop: 24,
            },
            children: `#${params.id}`,
          },
        },
      ],
    },
  }
}

/**
 * Minimal Inter font data loader.
 * Uses a system font fallback via a basic sans-serif font buffer.
 * In production, replace with actual Inter font file loading.
 */
async function loadFont(): Promise<ArrayBuffer> {
  // Fetch Inter font from Google Fonts CDN
  const fontUrl = 'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff2'

  try {
    const response = await fetch(fontUrl)
    if (response.ok) {
      return await response.arrayBuffer()
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: create a minimal font buffer (satori requires at least one font)
  // This produces blank text but prevents crashes
  return new ArrayBuffer(0)
}

let fontCache: ArrayBuffer | null = null

async function getFont(): Promise<ArrayBuffer> {
  if (!fontCache) {
    fontCache = await loadFont()
  }
  return fontCache
}

export async function handleOgImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const params = parseParams(url)

  if (!params) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing or invalid query params. Required: type (climb|profile|session), id, boardName' }))
    return
  }

  try {
    const fontData = await getFont()
    const markup = buildMarkup(params)

    const svg = await satori(markup, {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fonts: [
        {
          name: 'Inter',
          data: fontData,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'Inter',
          data: fontData,
          weight: 700,
          style: 'normal',
        },
      ],
    })

    const resvg = new Resvg(svg, {
      fitTo: {
        mode: 'width',
        value: OG_WIDTH,
      },
    })
    const pngData = resvg.render()
    const pngBuffer = pngData.asPng()

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      'Content-Length': pngBuffer.length.toString(),
    })
    res.end(pngBuffer)
  } catch (error) {
    console.error('[OG Image] Generation failed:', error)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Failed to generate image' }))
  }
}
