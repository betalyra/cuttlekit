# Dynamic Font Loading for Generative UI

## Goal

Enable the AI to specify custom fonts in generated UIs without bundling fonts upfront. Fonts should load on-demand when the AI uses them.

---

## The Challenge

Unlike icons (which are small SVGs), fonts are:
- **Large** (~20-100KB per weight/style)
- **Require CSS @font-face** declarations before use
- **Need to load before rendering** to avoid FOUT (Flash of Unstyled Text)

We need a solution that:
1. Lets AI specify any font from a large library
2. Doesn't bloat the initial bundle
3. Loads fonts dynamically at runtime
4. Works with plain HTML (no build step for generated content)

---

## Option A: Fontsource API + Auto-Discovery (Recommended)

Use Fontsource's API to auto-discover font metadata, then load from jsDelivr CDN. No hardcoded whitelist needed.

### How It Works

1. AI generates HTML with font-family (inline styles, Tailwind classes, etc.)
2. Frontend renders HTML to DOM
3. Frontend reads `getComputedStyle().fontFamily` from all elements
4. For each custom font, query Fontsource API for metadata (cached)
5. Inject `@font-face` pointing to CDN, browser loads font and re-renders

### Implementation

```typescript
// fonts.ts - Font loader using Fontsource API for metadata
const loadedFonts = new Set<string>()
const metadataCache = new Map<string, FontMetadata | null>()
const SYSTEM_FONTS = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace'])

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
    const data = await res.json() as FontMetadata
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
    const font = new FontFace(
      fontFamily,
      `url(${cdnUrl(id, `:vf@latest/${subset}-wght-normal.woff2`)})`,
      { weight: '100 900', style: 'normal', display: 'swap' }
    )
    await font.load()
    document.fonts.add(font)
    return
  }

  // Load static weights from API metadata
  await Promise.allSettled(
    meta.weights.map(async w => {
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

// Detect fonts from rendered DOM
function detectFonts(root: Element): Set<string> {
  const fonts = new Set<string>()
  for (const el of [root, ...root.querySelectorAll('*')]) {
    getComputedStyle(el).fontFamily.split(',').forEach(f => {
      const name = f.trim().replace(/['"]/g, '')
      if (name && !SYSTEM_FONTS.has(name.toLowerCase())) fonts.add(name)
    })
  }
  return fonts
}

// Call after DOM update
export const loadFontsFromDOM = (root: Element = document.body) =>
  Promise.all([...detectFonts(root)].map(loadFont))

// Preload default font at startup
loadFont('Inter')
```

### Integration in main.ts

```typescript
handleStreamEvent(event: StreamEvent) {
  switch (event.type) {
    case "html":
      this.getElements().contentEl.innerHTML = event.html
      loadFontsFromDOM(this.getElements().contentEl) // Detect fonts from rendered DOM
      break
  }
}
```

### Why This Is Better

- **API-driven** - Uses Fontsource API to get correct subset, weights, and variable font info
- **No hardcoded subsets** - Works with any language (Latin, CJK, Arabic, Cyrillic, etc.)
- **Loads exactly what's needed** - Only fetches weights the font actually supports
- **No regex** - Uses `getComputedStyle()` which the browser already computed
- **Works with Tailwind** - Catches `font-['Inter']` classes since they become computed styles
- **Future-proof** - Any way the AI specifies fonts (inline, classes, CSS vars) just works

### System Prompt Addition

```
FONTS:
Use any Google Font or open-source font by name (loaded on-demand from Fontsource CDN):
- Inter, Roboto, Open Sans (clean sans-serif)
- Playfair Display, Merriweather (elegant serif)
- JetBrains Mono, Fira Code (monospace)
- Space Grotesk, Poppins (modern geometric)

Example: style="font-family: 'Space Grotesk', sans-serif"

Stick to Inter unless a specific aesthetic is requested.
```

### Pros
- **No regex parsing** - Uses browser's computed styles for font detection
- **Works with any syntax** - Inline styles, Tailwind classes, CSS variables all work
- **Correct subset/weights** - API provides exact metadata (no guessing)
- **Language-agnostic** - Works with any script (Latin, CJK, Arabic, etc.)
- **Auto-detects variable fonts** - Uses single file when available
- **Graceful fallback** - Unknown fonts just show system font
- **Cached metadata** - API only called once per font

### Cons
- Brief FOUT (~50-100ms) while font loads
- Extra API call on first use of each font
- Relies on Fontsource API availability

---

## Option B: CSS Font Loading API (More Control)

Use the browser's native FontFace API for programmatic loading.

### Implementation

```typescript
const loadedFonts = new Set<string>()

export async function loadFontProgrammatic(fontFamily: string, weight = '400'): Promise<void> {
  const key = `${fontFamily}-${weight}`
  if (loadedFonts.has(key)) return

  const fontId = fontFamily.toLowerCase().replace(/\s+/g, '-')
  const url = `https://cdn.jsdelivr.net/fontsource/fonts/${fontId}@latest/latin-${weight}-normal.woff2`

  const font = new FontFace(fontFamily, `url(${url})`, {
    weight,
    style: 'normal',
    display: 'swap',
  })

  try {
    await font.load()
    document.fonts.add(font)
    loadedFonts.add(key)
  } catch (e) {
    console.warn(`Failed to load font: ${fontFamily}`, e)
  }
}

// Wait for all fonts to be ready
export async function ensureFontsReady(): Promise<void> {
  await document.fonts.ready
}
```

### Pros
- Full control over loading lifecycle
- Can preload fonts before rendering
- Native browser API

### Cons
- More complex code
- Must track each weight separately for static fonts
- Same whitelist limitation

---

## Option C: Google Fonts Fallback (Simplest)

Use Google Fonts API for maximum font variety.

### Implementation

```typescript
const loadedFontLinks = new Set<string>()

export function loadGoogleFont(fontFamily: string, weights = '400;500;700'): void {
  const encoded = encodeURIComponent(fontFamily)
  const key = `${fontFamily}-${weights}`

  if (loadedFontLinks.has(key)) return

  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encoded}:wght@${weights}&display=swap`
  document.head.appendChild(link)

  loadedFontLinks.add(key)
}
```

### System Prompt (Open-ended)

```
FONTS:
Use Google Fonts by specifying font-family. Popular options:
- Inter, Roboto, Open Sans (clean sans-serif)
- Playfair Display, Merriweather (elegant serif)
- JetBrains Mono, Fira Code (monospace)
- Poppins, Montserrat (modern geometric)

The font will be loaded automatically from Google Fonts.
```

### Pros
- Simplest implementation
- Access to entire Google Fonts library (1500+ fonts)
- AI has more creative freedom

### Cons
- Google Fonts privacy concerns (tracks users)
- Extra DNS lookup to fonts.googleapis.com
- AI might pick obscure fonts that don't match the aesthetic

---

## Option D: Preloaded Font Subset (No Runtime Loading)

Bundle a curated set of fonts in the build.

### Implementation

```bash
pnpm add @fontsource/inter @fontsource/playfair-display @fontsource/jetbrains-mono
```

```typescript
// main.ts
import '@fontsource/inter/variable.css'
import '@fontsource/playfair-display/variable.css'
import '@fontsource/jetbrains-mono/variable.css'
```

### Pros
- No runtime loading latency
- No FOUT
- No external dependencies

### Cons
- Increases bundle size (~100-300KB for 3 variable fonts)
- Limited to bundled fonts only
- Must rebuild to add fonts

---

## Recommendation

**Option A (Fontsource API + Auto-Discovery)** is the best fit because:

1. **No whitelist needed** - AI can use any of 1500+ open-source fonts
2. **Auto-detects variable fonts** - Single file for all weights when available
3. **Graceful degradation** - Unknown fonts fall back to system fonts
4. **Cached metadata** - API call only happens once per font
5. **No bundle impact** - Fonts load from CDN on-demand

---

## Implementation Checklist

- [x] Create `fonts.ts` utility with Fontsource API auto-discovery
- [x] Add `loadFontsFromDOM()` call after receiving HTML
- [x] Update system prompt with font examples
- [ ] Test FOUT behavior and consider preloading Inter as default
- [ ] Optional: Add `font-display: swap` skeleton styles

---

## Trade-offs Summary

| Option | Bundle Impact | Font Variety | FOUT | Privacy |
|--------|---------------|--------------|------|---------|
| A. Fontsource API | None | 1500+ fonts | ~50ms | Good |
| B. FontFace API | None | 1500+ fonts | Controllable | Good |
| C. Google Fonts | None | 1500+ fonts | ~50ms | Poor |
| D. Bundled | +100-300KB | Fixed | None | Good |

---

## References

- [Fontsource CDN Documentation](https://fontsource.org/docs/getting-started/cdn)
- [Fontsource Install Guide](https://fontsource.org/docs/getting-started/install)
- [CSS Font Loading API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Font_Loading_API)
- [jsDelivr CDN](https://www.jsdelivr.com/)
