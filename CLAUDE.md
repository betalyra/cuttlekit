## Approach Log

When making significant changes to the architecture or solving notable problems, document them in `docs/APPROACH.md`:
- Add a new numbered step (e.g., "## Step 12: ...")
- Focus on the **problem** that motivated the change
- Describe the **solution** at a high level
- Note any **trade-offs** or **results**
- Keep it concise - bullet points preferred
- Update "Key Takeaways" if a fundamental insight was gained

---

Use functional programming style using effect-ts.
When doing array operations, use effects Array for mapping, folding, etc.
When running multiple effects on an array, use the Effect.forEach pattern:
const results = yield* pipe(items, Effect.forEach(item => Effect.gen(function*(){ ... })))
When creating Effect services, use Effect.Service pattern:

// :white_check_mark: Correct: Class-based service with Effect.Service
export class EpisodeService extends Effect.Service<EpisodeService>()(
  "EpisodeService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const repository = yield* EpisodeRepository

      const findById = (id: string) => repository.findById(id)
      const create = (data: CreateEpisodeData) => repository.create(data)

      return { findById, create } as const
    })
  }
) {}


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


