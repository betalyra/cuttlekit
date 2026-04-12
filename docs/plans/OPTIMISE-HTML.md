# Optimise HTML Page State in LLM Prompts

## Problem

Despite the component registry compacting custom element instances (stripping template markup, keeping only `data-children` content), the `[PAGE STATE]` section still grows large. The example prompt shows ~4KB of HTML for a single meetup landing page, dominated by:

1. **Tailwind class strings** — repeated verbose class lists on every element (`class="bg-white border-4 border-[#0a0a0a] px-4 py-2 font-black rotate-[-2deg]"`)
2. **Decorative/static elements** — stickers, blur divs, halftone overlays, azulejo tiles that never change
3. **Inline styles** — `style="font-family: 'Space Grotesk'"` repeated across elements
4. **Deeply nested non-component HTML** — the hero section, stats row, footer are not componentised and carry full markup

The compact HTML pipeline (`getCompactHtmlFromCtx`) only strips CE template interiors — everything else passes through verbatim.

---

## Current Compression Pipeline

```
Full VDOM (happy-dom)
  → getCompactHtmlFromCtx(): strip CE template content, keep data-children
  → [PAGE STATE] in prompt
```

Component instances like `<ticker-tape text="...">` are already compact. The bloat comes from non-component HTML.

---

## Proposed Optimisations

### 1. LLM-Controlled Style Registry

**Idea:** Mirror the component registry pattern — the LLM defines named styles via a new `{"op":"style",...}` operation, then references them with a `$` prefix in class attributes. The backend maintains a per-session style registry, expands tokens when applying to the real DOM, and compresses them back in the compact page state.

**LLM defines a style:**
```jsonl
{"op":"style","name":"sticker-badge","class":"bg-white border-4 border-[#0a0a0a] px-4 py-2 font-black"}
```

**LLM uses it in patches:**
```jsonl
{"op":"patches","patches":[{"selector":"#stats-row","append":"<div id='stat-new' class='$sticker-badge rotate-[2deg]'>NEW</div>"}]}
```

**LLM restyles (same name, new class):**
```jsonl
{"op":"style","name":"sticker-badge","class":"bg-zinc-900 text-white border-2 border-zinc-700 px-4 py-2 font-mono"}
```

**Prompt sections:**
```
[STYLES]
$sticker-badge = bg-white border-4 border-[#0a0a0a] px-4 py-2 font-black
$card-shadow = border-4 border-[#0a0a0a] shadow-[8px_8px_0px_0px_#0a0a0a]

[PAGE STATE]
<div id="stat-1" class="$sticker-badge rotate-[-2deg]">120+ ATTENDEES</div>
<div id="stat-2" class="$sticker-badge rotate-[3deg]">FREE SNACKS</div>
```

**Why LLM-controlled > backend extraction:**
- LLM knows semantic intent ("badge style" vs "classes that happen to overlap")
- Restyle works exactly like component restyle — redefine the name
- No fragile clustering heuristics or Jaccard thresholds
- Styles persist in `[STYLES]` like `[COMPONENTS]` — LLM reuses across requests
- Follows established pattern, lower cognitive overhead for the model

**Implementation:**
- Add `StyleRegistry` (per-session `Map<string, string>`) alongside component registry
- New op handler: `{"op":"style"}` → register/update style in registry
- **Expand on write:** When applying patches to the VDOM, expand `$token` references to full class strings (real DOM always has full classes for Tailwind to work)
- **Compress on read:** In `getCompactHtmlFromCtx()`, scan class attributes and substitute known style strings back to `$token` references
- Emit `[STYLES]` section in prompt (before `[PAGE STATE]`, after `[COMPONENTS]`)
- Add system prompt section explaining the style op
- Persist styles in session snapshots alongside component registry

**Matching strategy for compress-on-read:**
- Exact substring match: if an element's class contains the full style string, replace it with `$name` and keep remaining classes
- Longest match first to avoid partial substitutions

**Complexity:** Medium. Mirrors existing component registry infra.

**Token savings estimate:** 20-40% of class-heavy pages. Compounds with component usage (components handle structure, styles handle appearance).

---

### 2. Static Element Elision

**Idea:** Elements marked `data-static` (or auto-detected as non-interactive + never patched) get replaced with a placeholder comment in the page state.

**Before:**
```html
<div id="halftone" class="absolute inset-0 pointer-events-none opacity-10" style="background-image: radial-gradient(...)"></div>
<div class="absolute top-1/2 right-0 w-64 h-64 bg-[#00FFFF] rounded-full filter blur-[100px] opacity-20 pointer-events-none"></div>
```

**After:**
```html
<!-- static: halftone overlay -->
<!-- static: 3 decorative blur elements -->
```

**Detection heuristics:**
- Has `pointer-events-none` class
- No `id`, `data-action`, or interactive children
- Never targeted by a patch in the session
- Pure decorative (blur, gradient, overlay patterns)

**Implementation:**
- Track which element IDs have been patched (already have this in VDOM)
- During compact HTML generation, collapse qualifying subtrees to comments
- If LLM needs the full element, `get_page_state` could have a `full: true` option

**Complexity:** Low-medium. Heuristic-based, low risk.

**Token savings estimate:** 10-25% depending on decoration density.

---

### 3. Auto-componentisation Suggestions

**Idea:** Detect repeated HTML structures and prompt the LLM to define components for them.

The stats row in the example has 9 nearly-identical badge elements that could be a `<stat-badge>` component. If componentised:

**Before (9 badges, ~900 chars):**
```html
<div class="bg-white border-4 border-[#0a0a0a] px-4 py-2 font-black rotate-[-2deg]">120+ ATTENDEES</div>
<div class="bg-[#FF00FF] text-white border-4 border-[#0a0a0a] px-4 py-2 font-black rotate-[3deg]">FREE SNACKS</div>
...
```

**After (~300 chars):**
```html
<stat-badge label="120+ ATTENDEES" color="white" rotate="-2"></stat-badge>
<stat-badge label="FREE SNACKS" color="[#FF00FF]" rotate="3"></stat-badge>
...
```

**Implementation options:**
- A) **Prompt-level hint**: Add a system prompt instruction: "When you notice 3+ similar elements, define a component first"
- B) **Backend detection**: After generation, detect repeated structures and suggest componentisation in the next corrective/follow-up prompt
- C) **Aggressive**: Auto-extract components from repeated DOM patterns server-side

Option A is cheapest and already partially covered by the COMPONENTS prompt section. Could strengthen the instruction.

**Complexity:** A = trivial, B = medium, C = high.

**Token savings estimate:** 30-60% for repetitive UIs (lists, grids, card layouts).

---

### 4. Attribute Minimisation

**Idea:** Strip attributes the LLM doesn't need to see from the compact page state.

Candidates for stripping:
- `class` on elements the LLM isn't currently restyling (risky — LLM may need context)
- `style` attributes that duplicate what's in a component template
- `draggable="true"`, `data-drag-item`, `data-drop-zone` (DnD plumbing)
- Redundant `data-action-data` when the action context is clear from the element

**Conservative approach:** Only strip attributes on elements inside registered components (template provides the style context).

**Complexity:** Low. Post-process the compact HTML with attribute whitelist per context.

**Token savings estimate:** 10-15%.

---

### 5. Two-Tier Page State

**Idea:** Default prompt gets a structural skeleton; full HTML available via `get_page_state`.

**Skeleton view:**
```
[PAGE STATE (skeleton)]
#root > .min-h-screen
  <ticker-tape#top-ticker>
  #landing > .max-w-3xl
    #hero > header
      h1 "EMBRACE:AI // 2026.02"
      #stats-row (9 stat badges)
    #main-grid > .grid.md:grid-cols-5
      #agenda-col (7 agenda-row items)
      #sidebar (4 embrace-card items)
      #speakers-col (2 speaker-bio items)
    #footer (rsvp-btn, spots-left)
  (5 sardine-sticker, 5 lisbon-sticker, 1 azulejo-tile) [decorative]
```

**When the LLM needs detail:** Call `get_page_state` or `get_element(selector)` for the specific subtree.

**Implementation:**
- Build a tree summariser that outputs indented structure with element counts
- Show IDs, component tags, text content snippets, and child counts
- Add a `get_element` tool that returns HTML for a specific subtree

**Complexity:** Medium-high. Requires the LLM to learn a new interaction pattern.

**Token savings estimate:** 60-80% on large pages, but adds latency for tool calls.

---

### 6. Incremental Page State

**Idea:** After the first request, only send the diff from the last known state.

**First request:** Full `[PAGE STATE]`
**Subsequent requests:**
```
[PAGE STATE delta since last response]
Modified: #stat-claps (text: "420" → "421")
Added: #new-card under #sidebar
Removed: #old-banner
Unchanged: 47 elements
```

**Implementation:**
- Track a "last-sent HTML" snapshot per session
- Diff against current VDOM before building prompt
- Fall back to full state every N requests or when delta > 50% of full

**Complexity:** Medium. Need a robust HTML differ.

**Token savings estimate:** 50-90% for action-heavy sessions (most elements unchanged).

---

## Recommendation: Phased Approach

### Phase 1 — LLM-controlled style registry (#1)
Highest impact-to-effort ratio. Mirrors the proven component registry pattern, so existing infra applies. Compounds with components: components handle structure, styles handle appearance. The LLM already understands the define/reuse pattern.

### Phase 2 — Static elision + componentisation nudge (#2, #3A)
Quick wins on top of the style registry. Heuristic elision for decorative elements, stronger prompt nudge for componentising repeated structures.

### Phase 3 — Two-tier / incremental state (#5, #6)
Ambitious but highest ceiling. Only worth pursuing if Phase 1+2 don't bring page state under a target threshold (e.g. < 2K tokens).

---

## Metrics to Track

- `pageStateTokens`: token count of `[PAGE STATE]` section per request
- `componentRatio`: % of page elements that are component instances
- `staticElementCount`: elements eligible for elision
- `classRepetitionScore`: how much class dedup would save
