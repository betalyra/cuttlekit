// fonts.ts - Font loader using Fontsource API for metadata

const loadedFonts = new Set<string>()
const metadataCache = new Map<string, FontMetadata | null>()

const SYSTEM_FONTS = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
])

type FontMetadata = {
  id: string
  subsets: string[]
  weights: number[]
  defSubset: string
  variable: boolean
}

const fontId = (name: string) => name.toLowerCase().replace(/\s+/g, '-')

const cdnUrl = (id: string, variant: string) =>
  `https://cdn.jsdelivr.net/fontsource/fonts/${id}${variant}`

async function getMetadata(id: string): Promise<FontMetadata | null> {
  if (metadataCache.has(id)) return metadataCache.get(id)!

  try {
    const res = await fetch(`https://api.fontsource.org/v1/fonts/${id}`)
    if (!res.ok) throw new Error('Not found')
    const data = (await res.json()) as FontMetadata
    metadataCache.set(id, data)
    return data
  } catch {
    metadataCache.set(id, null)
    return null
  }
}

async function loadFont(fontFamily: string): Promise<void> {
  if (loadedFonts.has(fontFamily) || SYSTEM_FONTS.has(fontFamily.toLowerCase())) return
  loadedFonts.add(fontFamily) // Mark early to prevent duplicate attempts

  const id = fontId(fontFamily)
  const meta = await getMetadata(id)

  if (!meta) {
    loadedFonts.delete(fontFamily)
    console.warn(`Font not found: ${fontFamily}`)
    return
  }

  const subset = meta.defSubset

  // Use variable font if available (single file, all weights)
  if (meta.variable) {
    try {
      const font = new FontFace(
        fontFamily,
        `url(${cdnUrl(id, `:vf@latest/${subset}-wght-normal.woff2`)})`,
        { weight: '100 900', style: 'normal', display: 'swap' }
      )
      await font.load()
      document.fonts.add(font)
      return
    } catch (e) {
      console.warn(`Failed to load variable font ${fontFamily}:`, e)
    }
  }

  // Load static weights from API metadata
  await Promise.allSettled(
    meta.weights.map(async (w) => {
      const font = new FontFace(
        fontFamily,
        `url(${cdnUrl(id, `@latest/${subset}-${w}-normal.woff2`)})`,
        { weight: String(w), style: 'normal', display: 'swap' }
      )
      await font.load()
      document.fonts.add(font)
    })
  )
}

// Extract fonts from HTML string (fast - no DOM traversal)
function extractFontsFromHTML(html: string): Set<string> {
  const fonts = new Set<string>()

  // Match font-family in style attributes, capturing until ; or end of style
  // Handles: font-family: 'Pixelify Sans', sans-serif
  const stylePattern = /font-family:\s*([^;}"]+)/gi
  let match
  while ((match = stylePattern.exec(html)) !== null) {
    // Parse the font list, handling quoted and unquoted names
    const fontList = match[1]
    // Split by comma, but respect quotes
    const fontNames = fontList.match(/(?:'[^']+'+|"[^"]+"|[^,]+)/g) || []
    fontNames.forEach((f) => {
      const name = f.trim().replace(/['"]/g, '')
      if (name && !SYSTEM_FONTS.has(name.toLowerCase())) {
        fonts.add(name)
      }
    })
  }

  // Match Tailwind arbitrary font classes: font-['Inter']
  const tailwindPattern = /font-\['([^']+)'\]/g
  while ((match = tailwindPattern.exec(html)) !== null) {
    fonts.add(match[1])
  }

  return fonts
}

// Load fonts from HTML string - call before/after rendering
export const loadFontsFromHTML = (html: string) =>
  Promise.all([...extractFontsFromHTML(html)].map(loadFont))

// Preload default font at startup
loadFont('Inter')
