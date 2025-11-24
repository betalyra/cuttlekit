Use functional programming style using effect-ts.
When doing array operations, use effects Array for mapping, folding, etc.
When running multiple effects on an array, use the Effect.forEach pattern:
const results = yield* pipe(items, Effect.forEach(item => Effect.gen(function*(){ ... })))
When creating Effect services, use Effect.Service pattern (like DrizzleService).
Prefer type aliases over interfaces.
Use react-icons remix icons when you choose a new icon.
Our page style is brutalist.
Always use es modules.
Tech stack:
- Vite, vitest
- Tsx, tsdown
- Tailwind
- Effect
- pnpm (w/ workspaces)
- zod
