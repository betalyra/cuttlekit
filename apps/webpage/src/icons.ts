// icons.ts - Icon loader using Iconify API

const ICONIFY_SCRIPT_URL = 'https://code.iconify.design/iconify-icon/2.3.0/iconify-icon.min.js'

let scriptLoaded = false
let scriptLoading: Promise<void> | null = null

// Ensure Iconify script is loaded
function ensureScript(): Promise<void> {
  if (scriptLoaded) return Promise.resolve()
  if (scriptLoading) return scriptLoading

  scriptLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = ICONIFY_SCRIPT_URL
    script.onload = () => {
      scriptLoaded = true
      resolve()
    }
    script.onerror = () => reject(new Error('Failed to load Iconify script'))
    document.head.appendChild(script)
  })

  return scriptLoading
}

// Extract icon names from HTML string (fast - no DOM traversal)
function extractIconsFromHTML(html: string): Set<string> {
  const icons = new Set<string>()

  // Match <iconify-icon icon="mdi:home"> patterns
  const pattern = /<iconify-icon[^>]+icon=["']([^"']+)["']/gi
  let match
  while ((match = pattern.exec(html)) !== null) {
    icons.add(match[1])
  }

  return icons
}

// Preload icons via Iconify API (if available)
async function preloadIcons(icons: string[]): Promise<void> {
  if (icons.length === 0) return

  await ensureScript()

  // Access Iconify API if available
  const iconify = (window as unknown as { Iconify?: { loadIcons: (icons: string[]) => void } }).Iconify
  if (iconify?.loadIcons) {
    iconify.loadIcons(icons)
  }
}

// Load icons from HTML string - call before/after rendering
export const loadIconsFromHTML = async (html: string): Promise<void> => {
  const icons = extractIconsFromHTML(html)
  if (icons.size > 0) {
    await preloadIcons([...icons])
  }
}

// Initialize script on module load
ensureScript()
