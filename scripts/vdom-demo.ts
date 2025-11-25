import { Window } from 'happy-dom'

// Initial HTML - simulating a simple counter app
const initialHtml = `<div id="app">
  <h1>Counter App</h1>
  <div id="counter">
    <span class="label">Count:</span>
    <span class="value">0</span>
  </div>
  <div id="controls">
    <button data-action="increment">+</button>
    <button data-action="decrement">-</button>
  </div>
  <ul id="history">
    <li>Started at 0</li>
  </ul>
</div>`

console.log('='.repeat(60))
console.log('VDOM Demo: happy-dom only (no diffdom needed)')
console.log('='.repeat(60))

// ============================================================
// PATCH FORMAT: What the LLM generates
// ============================================================

type Patch =
  | { selector: string; text: string }
  | { selector: string; attr: Record<string, string> }
  | { selector: string; append: string }
  | { selector: string; prepend: string }
  | { selector: string; html: string }
  | { selector: string; remove: true }

// ============================================================
// SERVER SIDE: happy-dom maintains the VDOM
// ============================================================

const serverWindow = new Window()
serverWindow.document.body.innerHTML = initialHtml

console.log('\n[SERVER] Initial state:')
console.log('  Counter:', serverWindow.document.querySelector('#counter .value')?.textContent)
console.log('  History items:', serverWindow.document.querySelectorAll('#history li').length)

// ============================================================
// PATCH APPLICATION: Native DOM methods, no diffdom
// ============================================================

type PatchResult = { success: true } | { success: false; error: string }

const applyPatch = (doc: Document, patch: Patch): PatchResult => {
  const el = doc.querySelector(patch.selector)
  if (!el) {
    return { success: false, error: `Element not found: ${patch.selector}` }
  }

  if ('text' in patch) {
    el.textContent = patch.text
  } else if ('attr' in patch) {
    for (const [key, value] of Object.entries(patch.attr)) {
      el.setAttribute(key, value)
    }
  } else if ('append' in patch) {
    el.insertAdjacentHTML('beforeend', patch.append)
  } else if ('prepend' in patch) {
    el.insertAdjacentHTML('afterbegin', patch.prepend)
  } else if ('html' in patch) {
    el.innerHTML = patch.html
  } else if ('remove' in patch) {
    el.remove()
  }

  return { success: true }
}

const applyPatches = (doc: Document, patches: Patch[]): { applied: number; errors: string[] } => {
  const errors: string[] = []
  let applied = 0

  for (const patch of patches) {
    const result = applyPatch(doc, patch)
    if (result.success) {
      applied++
    } else {
      errors.push(result.error)
    }
  }

  return { applied, errors }
}

// ============================================================
// SIMULATE: User clicks increment
// ============================================================

console.log('\n[USER] Clicked increment button')
console.log('\n[LLM] Generating patches (not full HTML)...')

const incrementPatches: Patch[] = [
  { selector: '#counter .value', text: '1' },
  { selector: '#counter .value', attr: { class: 'value updated' } },
  { selector: '#history', append: '<li>Incremented to 1</li>' }
]

console.log('[LLM] Patches:', JSON.stringify(incrementPatches, null, 2))

console.log('\n[SERVER] Applying patches with native DOM methods...')
const result1 = applyPatches(serverWindow.document as unknown as Document, incrementPatches)
console.log(`[SERVER] Applied ${result1.applied}/${incrementPatches.length} patches`)

console.log('\n[SERVER] State after increment:')
console.log('  Counter:', serverWindow.document.querySelector('#counter .value')?.textContent)
console.log('  Counter class:', serverWindow.document.querySelector('#counter .value')?.className)
console.log('  History items:', serverWindow.document.querySelectorAll('#history li').length)

// ============================================================
// SIMULATE: User clicks increment again
// ============================================================

console.log('\n[USER] Clicked increment button again')

const incrementPatches2: Patch[] = [
  { selector: '#counter .value', text: '2' },
  { selector: '#history', append: '<li>Incremented to 2</li>' }
]

console.log('[LLM] Patches:', JSON.stringify(incrementPatches2, null, 2))

const result2 = applyPatches(serverWindow.document as unknown as Document, incrementPatches2)
console.log(`[SERVER] Applied ${result2.applied}/${incrementPatches2.length} patches`)

console.log('\n[SERVER] State after second increment:')
console.log('  Counter:', serverWindow.document.querySelector('#counter .value')?.textContent)
console.log('  History items:', serverWindow.document.querySelectorAll('#history li').length)

// ============================================================
// SIMULATE: Error case - bad selector
// ============================================================

console.log('\n[LLM] Generating patch with bad selector (simulating LLM error)...')

const badPatches: Patch[] = [
  { selector: '#nonexistent', text: 'oops' }
]

const result3 = applyPatches(serverWindow.document as unknown as Document, badPatches)
console.log(`[SERVER] Applied ${result3.applied}/${badPatches.length} patches`)
console.log('[SERVER] Errors:', result3.errors)
console.log('[SERVER] → Would retry with LLM, providing error feedback')

// ============================================================
// NETWORK: Send full HTML to client
// ============================================================

console.log('\n' + '-'.repeat(60))
console.log('[NETWORK] Sending full HTML to client')

const finalHtml = serverWindow.document.body.innerHTML
console.log('[NETWORK] Payload size:', finalHtml.length, 'bytes')

// ============================================================
// CLIENT: Just render it
// ============================================================

const clientWindow = new Window()
clientWindow.document.body.innerHTML = finalHtml

console.log('\n[CLIENT] Rendered HTML. Final state:')
console.log('  Counter:', clientWindow.document.querySelector('#counter .value')?.textContent)
console.log('  History items:', clientWindow.document.querySelectorAll('#history li').length)

// ============================================================
// SUMMARY
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Summary:')
console.log('='.repeat(60))
console.log(`
Architecture:
  1. Server maintains VDOM via happy-dom
  2. LLM generates CSS selector patches (few tokens)
  3. Server applies patches with native DOM methods
  4. Server sends full HTML to client
  5. Client just renders (innerHTML)

No diffdom needed because:
  - LLM IS our diff engine (generates patches directly)
  - Native DOM methods handle patch application
  - No need to diff two trees

Token savings example:
  - Full HTML: ~300 tokens per request
  - Patches: ~30-50 tokens per request
  - 6-10x reduction in LLM output
`)
