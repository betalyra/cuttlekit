# Iconify Integration for Generative UI

## Goal

Enable the AI to generate UIs with icons without bloating the bundle. Icons should load on-demand from the Iconify API.

---

## Recommendation: Web Component Approach

Use the `<iconify-icon>` web component. It's framework-agnostic, works with plain HTML, and loads icons on-demand from the Iconify API.

### Why Web Component?

| Approach | Bundle Impact | AI Compatibility | On-Demand |
|----------|---------------|------------------|-----------|
| Web Component | ~50KB (one-time) | Excellent - plain HTML | Yes |
| React Component | ~15KB + framework | Requires JSX | Yes |
| SVG Framework | ~80KB | Complex API | Optional |
| Static SVGs | Per-icon | HTML but verbose | No |

The web component wins because:
1. **Plain HTML** - AI generates `<iconify-icon icon="mdi:home">` just like any other element
2. **On-demand loading** - Icons fetch from Iconify API only when rendered
3. **200,000+ icons** - Access to Material Design, Font Awesome, Lucide, Tabler, etc.
4. **No build step** - Works immediately in generated HTML

---

## Implementation

### Step 1: Add the Web Component Script

Add to `apps/webpage/index.html`:

```html
<script src="https://code.iconify.design/iconify-icon/2.3.0/iconify-icon.min.js"></script>
```

Or install via npm for local serving:

```bash
pnpm add iconify-icon
```

```typescript
// main.ts
import 'iconify-icon'
```

### Step 2: Update System Prompt

Add to `FULL_HTML_SYSTEM_PROMPT` in `generate.ts`:

```
ICONS:
Use Iconify web component for icons:
- <iconify-icon icon="mdi:home"></iconify-icon>
- <iconify-icon icon="lucide:search" width="24"></iconify-icon>
- <iconify-icon icon="tabler:plus" class="text-blue-500"></iconify-icon>

Popular icon sets:
- mdi: Material Design Icons (mdi:home, mdi:account, mdi:cog)
- lucide: Lucide Icons (lucide:search, lucide:menu, lucide:x)
- tabler: Tabler Icons (tabler:plus, tabler:trash, tabler:edit)
- ph: Phosphor Icons (ph:house, ph:user, ph:gear)

Icons inherit text color via currentColor. Size with width/height attributes or Tailwind classes.
```

### Step 3: Example Generated HTML

The AI can now generate:

```html
<button data-action="add" class="flex items-center gap-2 px-4 py-2 bg-neutral-900 text-white">
  <iconify-icon icon="lucide:plus" width="16"></iconify-icon>
  Add Item
</button>

<div class="flex items-center gap-3">
  <iconify-icon icon="mdi:account-circle" width="40" class="text-neutral-400"></iconify-icon>
  <span>John Doe</span>
</div>

<nav class="flex gap-4">
  <a href="#" class="flex items-center gap-1">
    <iconify-icon icon="tabler:home"></iconify-icon>
    Home
  </a>
  <a href="#" class="flex items-center gap-1">
    <iconify-icon icon="tabler:settings"></iconify-icon>
    Settings
  </a>
</nav>
```

---

## How It Works

1. Browser encounters `<iconify-icon icon="mdi:home">`
2. Web component checks if icon is cached locally
3. If not cached, fetches from `https://api.iconify.design/mdi/home.json`
4. Renders inline SVG inside the custom element
5. Subsequent uses of same icon are instant (cached)

---

## Considerations

### Pros
- Zero bundle impact for icons (only ~50KB for the web component itself)
- AI can use any of 200,000+ icons with simple syntax
- Icons are semantic in HTML (`icon="mdi:delete"` is readable)
- Styling works with Tailwind (color, size via classes)
- No build-time icon bundling needed

### Cons
- Requires internet connection for first load of each icon
- Small latency on first render of new icons (~50-100ms)
- Iconify API dependency (can self-host if needed)

### Mitigations
- Icons are cached in localStorage after first fetch
- Can preload common icons if needed
- Self-hosting option available for offline use

---

## Alternative: Offline Bundle (Not Recommended)

If offline support is critical, you could bundle specific icon sets:

```bash
pnpm add @iconify-json/mdi @iconify-json/lucide
```

```typescript
import { addCollection } from 'iconify-icon'
import mdiIcons from '@iconify-json/mdi'
addCollection(mdiIcons)
```

This defeats the purpose of on-demand loading and adds significant bundle size. Only use if offline support is required.

---

## Implementation Checklist

- [x] Add `iconify-icon` script or npm package
- [x] Update system prompt with icon usage instructions
- [ ] Test AI generates icons correctly
- [ ] Verify icons load on-demand
- [ ] Optional: Add icon preloading for common icons

---

## References

- [Iconify Web Component Docs](https://iconify.design/docs/iconify-icon/)
- [Icon Sets Browser](https://icon-sets.iconify.design/)
- [API Documentation](https://iconify.design/docs/api/)
