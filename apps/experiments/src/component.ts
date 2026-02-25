/**
 * Component Registry Experiment — Light DOM + Patches
 *
 * Self-contained Patch type. Default: granular patches (append, attr, remove).
 * Fallback: html patch for full reset when things break.
 * CEs render into light DOM with [data-children] for child projection.
 * Outputs component-steps.html with server (happy-dom) vs browser DOM comparison.
 */

import { Effect, pipe } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Window, HTMLElement as HappyHTMLElement } from "happy-dom"
import { writeFileSync } from "node:fs"

// ============================================================
// Types
// ============================================================

type ComponentSpec = {
  readonly tag: string
  readonly props: readonly string[]
  readonly template: string
  readonly version: number
}

type DefineOp = {
  readonly op: "define"
  readonly tag: string
  readonly props: readonly string[]
  readonly template: string
}

type Patch =
  | { readonly selector: string; readonly append: string }
  | { readonly selector: string; readonly prepend: string }
  | { readonly selector: string; readonly attr: Record<string, string | null> }
  | { readonly selector: string; readonly remove: true }
  | { readonly selector: string; readonly text: string }
  | { readonly selector: string; readonly html: string }

type Op = DefineOp | Patch
type Registry = Map<string, ComponentSpec>

// ============================================================
// CE rendering — light DOM with child preservation
// ============================================================

const interpolate = (template: string, props: readonly string[], el: HappyHTMLElement) =>
  props.reduce(
    (acc, prop) => acc.replaceAll(`{${prop}}`, el.getAttribute(prop) ?? ""),
    template
  )

const makeCEShell = (registry: Registry, tag: string) => {
  const props = registry.get(tag)?.props ?? []
  return class extends HappyHTMLElement {
    static observedAttributes = [...props]
    connectedCallback() {}
    attributeChangedCallback() { if (this.isConnected) this.render() }
    render() {
      const spec = registry.get(tag)
      if (!spec) return
      const existing = this.querySelector("[data-children]")
      const children = [...(existing ?? this).children]
      this.innerHTML = interpolate(spec.template, spec.props, this)
      const container = this.querySelector("[data-children]")
      if (container) children.forEach((c) => container.appendChild(c))
    }
  }
}

// ============================================================
// Render tree — all CEs in document order (top-down)
// ============================================================

const renderTree = (win: InstanceType<typeof Window>, registry: Registry) =>
  pipe(
    [...win.document.querySelectorAll("*")]
      .filter((el) => registry.has(el.tagName.toLowerCase())),
    Effect.forEach((el) => Effect.sync(() => (el as any).render()))
  )

// ============================================================
// Patch executor
// ============================================================

const applyPatch = (win: InstanceType<typeof Window>, patch: Patch) =>
  Effect.sync(() => {
    const el = win.document.querySelector(patch.selector)
    if (!el) return
    if ("append" in patch) el.insertAdjacentHTML("beforeend", patch.append)
    else if ("prepend" in patch) el.insertAdjacentHTML("afterbegin", patch.prepend)
    else if ("html" in patch) el.innerHTML = patch.html
    else if ("text" in patch) el.textContent = patch.text
    else if ("attr" in patch) Object.entries(patch.attr).forEach(([k, v]) => v === null ? el.removeAttribute(k) : el.setAttribute(k, v))
    else if ("remove" in patch) el.remove()
  })

// ============================================================
// Op executors
// ============================================================

const executeDef = (win: InstanceType<typeof Window>, registry: Registry, op: DefineOp) =>
  Effect.gen(function* () {
    const existing = registry.get(op.tag)
    const version = existing ? existing.version + 1 : 1
    registry.set(op.tag, { tag: op.tag, props: op.props, template: op.template, version })
    if (!win.customElements.get(op.tag)) {
      win.customElements.define(op.tag, makeCEShell(registry, op.tag) as any)
    }
    yield* pipe(
      [...win.document.querySelectorAll(op.tag)],
      Effect.forEach((el) => Effect.sync(() => (el as any).render()))
    )
  })

const executePatch = (win: InstanceType<typeof Window>, registry: Registry, patch: Patch) =>
  Effect.gen(function* () {
    // Bootstrap #root on first structural mutation
    const needsRoot = ("append" in patch || "html" in patch) && patch.selector === "#root"
    if (needsRoot && !win.document.querySelector("#root")) {
      win.document.body.innerHTML = `<div id="root"></div>`
    }

    yield* applyPatch(win, patch)

    // Render CEs after structural mutations (attr handled by CE lifecycle)
    if ("append" in patch || "prepend" in patch || "html" in patch) {
      yield* renderTree(win, registry)
    }
  })

const applyOp = (win: InstanceType<typeof Window>, registry: Registry, op: Op) =>
  "op" in op
    ? executeDef(win, registry, op)
    : executePatch(win, registry, op)

// ============================================================
// Simulated LLM ops — Project Board
// ============================================================

const defineProjectCard: DefineOp = {
  op: "define", tag: "project-card", props: ["name", "status"],
  template: `<div style="border:2px solid #999;border-radius:8px;padding:16px;margin-bottom:16px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #eee"><h3 style="margin:0;font-weight:bold;font-size:18px">{name}</h3><span style="color:#666;font-size:14px">{status}</span></div><div data-children></div></div>`,
}

const defineTaskItem: DefineOp = {
  op: "define", tag: "task-item", props: ["title", "done"],
  template: `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:14px"><span style="color:#999;font-size:16px">{done}</span><span>{title}</span></div>`,
}

const renderBoard: Patch = {
  selector: "#root",
  append: [
    `<h2 style="font-family:sans-serif;margin-bottom:16px">Project Board</h2>`,
    `<project-card id="p1" name="Project Alpha" status="Active">`,
    `<task-item id="t1" title="Design mockups" done="☐"></task-item>`,
    `<task-item id="t2" title="Build prototype" done="☐"></task-item>`,
    `</project-card>`,
    `<project-card id="p2" name="Project Beta" status="Planning">`,
    `<task-item id="t4" title="Write RFC" done="☐"></task-item>`,
    `<task-item id="t5" title="Gather feedback" done="☐"></task-item>`,
    `</project-card>`,
  ].join(""),
}

const appendTask: Patch = {
  selector: "#p1 [data-children]",
  append: `<task-item id="t3" title="Write tests" done="☐"></task-item>`,
}

const markDone: Patch = { selector: "#t1", attr: { done: "☑" } }

const appendBetaTask: Patch = {
  selector: "#p2 [data-children]",
  append: `<task-item id="t6" title="Security review" done="☐"></task-item>`,
}

const markBetaDone: Patch = { selector: "#t4", attr: { done: "☑" } }

const updateProjectStatus: Patch = { selector: "#p1", attr: { status: "Completed" } }

const defineStatusBadge: DefineOp = {
  op: "define", tag: "status-badge", props: ["type", "label"],
  template: `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:{type};color:#fff">{label}</span>`,
}

const appendBadge: Patch = {
  selector: "#p2 [data-children]",
  append: `<status-badge id="b1" type="#e74c3c" label="Blocked"></status-badge>`,
}

const removeT2: Patch = { selector: "#t2", remove: true }

const appendReplacement: Patch = {
  selector: "#p1 [data-children]",
  append: `<task-item id="t10" title="Revised scope" done="☐"></task-item>`,
}

const appendEmptyGamma: Patch = {
  selector: "#root",
  append: `<project-card id="p3" name="Project Gamma" status="New"></project-card>`,
}

const populateGamma: Patch = {
  selector: "#p3 [data-children]",
  append: `<task-item id="t20" title="Kick-off meeting" done="☐"></task-item>`,
}

const restyleTaskItem: DefineOp = {
  op: "define", tag: "task-item", props: ["title", "done"],
  template: `<div style="display:flex;align-items:center;gap:10px;padding:8px;border:3px solid #000;margin-bottom:4px;background:#fff;font-family:monospace;text-transform:uppercase;font-weight:bold"><span style="font-size:18px">{done}</span><span>{title}</span></div>`,
}

const restyleProjectCard: DefineOp = {
  op: "define", tag: "project-card", props: ["name", "status"],
  template: `<div style="border:4px solid #000;padding:16px;margin-bottom:16px;background:#ff0;box-shadow:8px 8px 0 0 #000"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:3px solid #000"><h3 style="margin:0;font-weight:900;font-size:20px;text-transform:uppercase;letter-spacing:2px">{name}</h3><span style="font-weight:900;font-size:14px">{status}</span></div><div data-children></div></div>`,
}

const removeBeta: Patch = { selector: "#p2", remove: true }
const removeT10: Patch = { selector: "#t10", remove: true }

// ============================================================
// Simulated LLM ops — Dashboard (page transition)
// ============================================================

const removeHeader: Patch = { selector: "#root > h2", remove: true }
const removeAlpha: Patch = { selector: "#p1", remove: true }
const removeGamma: Patch = { selector: "#p3", remove: true }

const defineMetricCard: DefineOp = {
  op: "define", tag: "metric-card", props: ["label", "value", "trend"],
  template: `<div style="padding:16px;border:1px solid #ddd;border-radius:8px;background:#fff"><div style="font-size:12px;color:#666;margin-bottom:4px">{label}</div><div style="font-size:28px;font-weight:700">{value}</div><div style="font-size:12px;color:{trend}">{trend}</div></div>`,
}

const defineDashSection: DefineOp = {
  op: "define", tag: "dash-section", props: ["title"],
  template: `<div style="margin-bottom:24px"><h3 style="font-size:16px;font-weight:600;margin:0 0 12px">{title}</h3><div data-children style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px"></div></div>`,
}

const renderDashboard: Patch = {
  selector: "#root",
  append: [
    `<h2 style="font-family:sans-serif;margin-bottom:16px">Analytics Dashboard</h2>`,
    `<dash-section id="ds1" title="Revenue">`,
    `<metric-card id="m1" label="MRR" value="$12,450" trend="green"></metric-card>`,
    `<metric-card id="m2" label="ARR" value="$149,400" trend="green"></metric-card>`,
    `<metric-card id="m3" label="Churn" value="2.1%" trend="red"></metric-card>`,
    `</dash-section>`,
    `<dash-section id="ds2" title="Usage">`,
    `<metric-card id="m4" label="DAU" value="1,234" trend="green"></metric-card>`,
    `<metric-card id="m5" label="Sessions" value="5,678" trend="green"></metric-card>`,
    `</dash-section>`,
  ].join(""),
}

const updateMetric: Patch = { selector: "#m1", attr: { value: "$13,200" } }

const prependAnnouncement: Patch = {
  selector: "#root",
  prepend: `<div id="announcement" style="padding:12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;margin-bottom:16px;font-size:14px">System maintenance scheduled for tonight</div>`,
}

// ============================================================
// Simulated LLM ops — Edge cases
// ============================================================

const defineDivider: DefineOp = {
  op: "define", tag: "section-divider", props: [],
  template: `<hr style="border:none;border-top:2px dashed #ddd;margin:24px 0">`,
}

const appendDivider: Patch = {
  selector: "#root",
  append: `<section-divider></section-divider>`,
}

const appendMixed: Patch = {
  selector: "#ds2 [data-children]",
  append: `<div style="padding:16px;border:1px dashed #ccc;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#999;font-size:14px">+ Add metric</div><metric-card id="m6" label="Errors" value="23" trend="red"></metric-card>`,
}

const restyleMetricCard: DefineOp = {
  op: "define", tag: "metric-card", props: ["label", "value", "trend"],
  template: `<div style="padding:16px;border:3px solid #000;background:#fff;font-family:monospace"><div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;font-weight:700">{label}</div><div style="font-size:32px;font-weight:900">{value}</div><div style="font-size:10px;font-weight:700;color:{trend}">{trend}</div></div>`,
}

// html patch — nuclear fallback when things are broken
const fullReset: Patch = {
  selector: "#root",
  html: [
    `<h2 style="font-family:sans-serif;margin-bottom:16px">Dashboard (reset)</h2>`,
    `<dash-section id="ds1" title="Revenue">`,
    `<metric-card id="m1" label="MRR" value="$15,000" trend="green"></metric-card>`,
    `</dash-section>`,
  ].join(""),
}

// ============================================================
// Scenario list
// ============================================================

const scenarios: readonly (readonly [string, Op])[] = [
  // --- Board setup ---
  ["Define <project-card>", defineProjectCard],
  ["Define <task-item>", defineTaskItem],
  ["Render board (append to empty #root)", renderBoard],
  // --- Board mutations ---
  ["Append task to Alpha", appendTask],
  ["Mark task done (leaf attr)", markDone],
  ["Append task to Beta", appendBetaTask],
  ["Mark Beta task done", markBetaDone],
  ["Update project status (container attr)", updateProjectStatus],
  ["Define <status-badge> (late component)", defineStatusBadge],
  ["Append badge to Beta", appendBadge],
  // --- Replace + populate ---
  ["Remove task from Alpha", removeT2],
  ["Append replacement task", appendReplacement],
  ["Append empty Gamma", appendEmptyGamma],
  ["Populate Gamma", populateGamma],
  // --- Restyle (re-define = bulk update all instances) ---
  ["Restyle <task-item>", restyleTaskItem],
  ["Restyle <project-card>", restyleProjectCard],
  // --- Remove ---
  ["Remove entire Beta (container + children)", removeBeta],
  ["Remove task from Alpha", removeT10],
  // --- Page transition: board → dashboard (remove + append) ---
  ["Remove board header", removeHeader],
  ["Remove Alpha", removeAlpha],
  ["Remove Gamma", removeGamma],
  ["Define <metric-card>", defineMetricCard],
  ["Define <dash-section> (container)", defineDashSection],
  ["Render dashboard (append to empty #root)", renderDashboard],
  // --- Dashboard mutations ---
  ["Update single metric (attr)", updateMetric],
  ["Prepend announcement", prependAnnouncement],
  // --- Edge cases ---
  ["Define <section-divider> (no props)", defineDivider],
  ["Append divider", appendDivider],
  ["Append mixed HTML + component", appendMixed],
  ["Restyle <metric-card>", restyleMetricCard],
  // --- html patch (nuclear fallback) ---
  ["Full reset via html patch", fullReset],
]

// ============================================================
// HTML file generation
// ============================================================

type Step = { readonly label: string; readonly op: string; readonly html: string }

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const generateHtmlFile = (steps: readonly Step[], ops: readonly Op[]) => {
  const stepBlocks = steps.map((s, i) => [
    `<div class="step">`,
    `  <div class="step-header">`,
    `    <span>${s.label}</span>`,
    `    <span class="sync" data-step="${i}"></span>`,
    `  </div>`,
    `  <details class="step-op">`,
    `    <summary>Op JSON</summary>`,
    `    <pre>${escapeHtml(s.op)}</pre>`,
    `  </details>`,
    `  <div class="step-columns">`,
    `    <div class="step-col">`,
    `      <div class="col-label">Server (happy-dom)</div>`,
    `      <div class="step-render">${s.html}</div>`,
    `    </div>`,
    `    <div class="step-col">`,
    `      <div class="col-label">Browser DOM</div>`,
    `      <div class="step-render" data-browser-step="${i}"></div>`,
    `    </div>`,
    `  </div>`,
    `</div>`,
  ].join("\n")).join("\n")

  const opsJson = JSON.stringify(ops)
  const serverHtmlsJson = JSON.stringify(steps.map((s) => s.html))

  const lines = [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `  <meta charset="utf-8">`,
    `  <title>Component Registry — Steps</title>`,
    `  <style>`,
    `    * { box-sizing: border-box; }`,
    `    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 24px; background: #fafafa; }`,
    `    h1 { font-size: 24px; margin-bottom: 4px; }`,
    `    .subtitle { color: #666; margin-bottom: 32px; font-size: 14px; }`,
    `    .step { margin-bottom: 24px; border: 1px solid #ddd; border-radius: 8px; background: #fff; overflow: hidden; }`,
    `    .step-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: #f5f5f5; border-bottom: 1px solid #ddd; font-weight: 600; font-size: 14px; }`,
    `    .sync { font-size: 12px; font-weight: 500; }`,
    `    .sync-ok { color: #22c55e; }`,
    `    .sync-fail { color: #ef4444; }`,
    `    .step-op { padding: 0 16px; border-bottom: 1px solid #eee; font-size: 13px; }`,
    `    .step-op summary { padding: 8px 0; cursor: pointer; color: #666; }`,
    `    .step-op pre { background: #f9f9f9; padding: 12px; border-radius: 4px; overflow-x: auto; margin-bottom: 12px; }`,
    `    .step-columns { display: grid; grid-template-columns: 1fr 1fr; }`,
    `    .step-col { padding: 16px; min-height: 20px; }`,
    `    .step-col:first-child { border-right: 1px solid #eee; }`,
    `    .col-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #999; margin-bottom: 8px; }`,
    `    .step-render { min-height: 20px; }`,
    `    project-card, task-item, status-badge, metric-card, dash-section, section-divider { display: contents; }`,
    `    #dom-workspace { display: none; }`,
    `  </style>`,
    `</head>`,
    `<body>`,
    `  <h1>Component Registry Experiment</h1>`,
    `  <p class="subtitle">Patches (append / attr / remove) + component define &middot; html as fallback &middot; server vs browser</p>`,
    stepBlocks,
    `  <div id="dom-workspace"></div>`,
    `  <script>`,
    `    const ops = ${opsJson};`,
    `    const serverHtmls = ${serverHtmlsJson};`,
    ``,
    `    const registry = new Map();`,
    `    const workspace = document.getElementById("dom-workspace");`,
    ``,
    `    const interpolate = (template, props, el) =>`,
    `      props.reduce((acc, prop) => acc.replaceAll("{" + prop + "}", el.getAttribute(prop) ?? ""), template);`,
    ``,
    `    const renderElement = (el) => {`,
    `      const spec = registry.get(el.tagName.toLowerCase());`,
    `      if (!spec) return;`,
    `      const existing = el.querySelector("[data-children]");`,
    `      const children = [...(existing ?? el).children];`,
    `      el.innerHTML = interpolate(spec.template, spec.props, el);`,
    `      const container = el.querySelector("[data-children]");`,
    `      if (container) children.forEach(c => container.appendChild(c));`,
    `    };`,
    ``,
    `    const renderTree = (root) => {`,
    `      const tags = [...registry.keys()];`,
    `      [...root.querySelectorAll("*")]`,
    `        .filter(el => tags.includes(el.tagName.toLowerCase()))`,
    `        .forEach(renderElement);`,
    `    };`,
    ``,
    `    const applyOp = (op) => {`,
    `      if ("op" in op && op.op === "define") {`,
    `        const existing = registry.get(op.tag);`,
    `        const version = existing ? existing.version + 1 : 1;`,
    `        registry.set(op.tag, { tag: op.tag, props: [...op.props], template: op.template, version });`,
    `        workspace.querySelectorAll(op.tag).forEach(renderElement);`,
    `        return;`,
    `      }`,
    ``,
    `      const needsRoot = ("append" in op || "html" in op) && op.selector === "#root";`,
    `      if (needsRoot && !workspace.querySelector("#root")) {`,
    `        workspace.innerHTML = '<div id="root"></div>';`,
    `      }`,
    ``,
    `      const el = workspace.querySelector(op.selector);`,
    `      if (!el) return;`,
    ``,
    `      if ("append" in op) { el.insertAdjacentHTML("beforeend", op.append); renderTree(workspace); }`,
    `      else if ("prepend" in op) { el.insertAdjacentHTML("afterbegin", op.prepend); renderTree(workspace); }`,
    `      else if ("html" in op) { el.innerHTML = op.html; renderTree(workspace); }`,
    `      else if ("attr" in op) {`,
    `        Object.entries(op.attr).forEach(([k, v]) => { if (v === null) el.removeAttribute(k); else el.setAttribute(k, v); });`,
    `        if (registry.has(el.tagName.toLowerCase())) renderElement(el);`,
    `      }`,
    `      else if ("text" in op) { el.textContent = op.text; }`,
    `      else if ("remove" in op) { el.remove(); }`,
    `    };`,
    ``,
    `    ops.forEach((op, i) => {`,
    `      applyOp(op);`,
    `      const panel = document.querySelector('[data-browser-step="' + i + '"]');`,
    `      if (panel) panel.innerHTML = workspace.innerHTML;`,
    `      const indicator = document.querySelector('.sync[data-step="' + i + '"]');`,
    `      const match = workspace.innerHTML === serverHtmls[i];`,
    `      indicator.textContent = match ? "\\u25cf match" : "\\u25cf mismatch";`,
    `      indicator.className = "sync " + (match ? "sync-ok" : "sync-fail");`,
    `    });`,
    `  </script>`,
    `</body>`,
    `</html>`,
  ]

  return lines.join("\n")
}

// ============================================================
// Program
// ============================================================

const program = Effect.gen(function* () {
  const server = new Window()
  const registry: Registry = new Map()
  const steps: Step[] = []
  const ops: Op[] = []

  yield* pipe(
    scenarios,
    Effect.forEach(([label, op]) =>
      Effect.gen(function* () {
        yield* applyOp(server, registry, op)
        const n = steps.length + 1
        const html = server.document.body.innerHTML
        steps.push({ label: `${n}. ${label}`, op: JSON.stringify(op, null, 2), html })
        ops.push(op)
        yield* Effect.log(`${n}. ${label}`)
      })
    )
  )

  const outputPath = new URL("../component-steps.html", import.meta.url)
  writeFileSync(outputPath, generateHtmlFile(steps, ops))
  yield* Effect.log(`Wrote ${outputPath.pathname}`)

  server.close()
}).pipe(Effect.withLogSpan("experiment"))

NodeRuntime.runMain(program)
