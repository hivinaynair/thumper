# PROTOTYPE — downloader page variants

**Throwaway. Do not build on this.**

**Question:** what should `/downloader` look like when the queue is mostly
playlist children, and every job carries a quality verdict?

The shipped page renders parents and their playlist children as one flat stack
of `<article>` cards, each dumping a dot-separated metadata string plus up to
five badge blocks. A 30-track Spotify playlist becomes 31 near-identical cards
with no expressed parent/child relationship. These variants each disagree about
how to fix that.

## Running it

```bash
bun run dev:web
```

Then `http://localhost:3004/downloader?variant=A`. Cycle with the floating bar
at the bottom, or the `←` / `→` arrow keys.

Two things stand between you and a populated page locally:

1. **Auth.** The Clerk key here is `pk_live`, domain-locked to `vinaynair.dev`,
   so you cannot sign in on localhost. Comment out `auth.protect()` in
   `apps/web/proxy.ts` — and restore it with `git checkout apps/web/proxy.ts`
   before committing anything.
2. **Data.** `/api/jobs` guards itself with its own `auth()` call and still
   401s, so the variants render empty. Paste `fixtures.js` from this folder
   into the devtools console; it patches `window.fetch` so the page's poll
   picks up a queue spanning the whole verdict range.

| Key | Variant | The bet |
| --- | --- | --- |
| `0` | Current — shipped design | Baseline, kept in the cycle so the others are judged against something real |
| `A` | Console — dense table | It's a work list. One sticky command bar, one table, children collapsed under their parent. 40 tracks on screen |
| `B` | Focus — list + detail | The verdict is the valuable part. Thin list, one selected job gets a whole pane |
| `C` | Feed — composer + timeline | Low-frequency, high-attention. The URL box is the hero and results read as prose verdicts, not badge stacks |

`A` and `C` are deliberately opposite trades on the same axis (density vs.
attention). `B` refuses the axis.

Every job carries a quality verdict, playlist children included — which is
where it matters most, since the child list is what you scan for the bad ones.
`verdictOf` derives it once so all three variants agree on *what* the verdict
is; each renders it differently. `lead` is for dense UI, `detail` for roomy UI.

## shadcn

Variant C is built on shadcn (`components/ui/*`, added via the CLI — the shadcn
MCP server failed to connect this session). The app had no Tailwind, so this
adds it. Three things keep it from touching the shipped pages:

- **No preflight.** `ui.css` imports only the theme and utility layers.
  Tailwind's reset is global and would flatten `app/globals.css`.
- **Utilities are unlayered.** `globals.css` styles `input, select, textarea`
  outside any cascade layer, and unlayered CSS beats layered CSS whatever the
  specificity — utilities inside `@layer utilities` silently lost to it.
- **Tokens are namespaced `--pv-*`.** Scoping to `.pv-ui` was not enough:
  globals' own rules (`a { color: var(--accent) }`, `.panel`, `.btn`) still
  apply inside `.pv-ui`, where they read our redefinitions. That rendered every
  link in a near-black surface colour until the tokens were renamed.

Since preflight is off, `ui.css` carries the slice of it shadcn depends on,
scoped to `.pv-ui` and parked in `@layer base` so utilities still outrank it.
Without it the ghost Button has no background class at all — it assumes
preflight made buttons transparent — and falls back to the UA's grey.

Variants A and B are still on the hand-rolled `prototype.css`. That is
deliberate: the point of the prototype is to pick a direction, not to polish
three. Convert the winner.

## Structure

- `view-model.ts` — the props bundle handed to each variant, plus `groupJobs`
  (parent/child grouping) and `verdictOf` (the shared verdict derivation).
- `variant-*.tsx` — one file each, free to throw out the layout entirely.
- `prototype.css` — styles for variants A and B, `pv-` prefixed.
- `ui.css` — Tailwind + shadcn tokens for variant C. Read the comments before
  changing the imports; the layering is load-bearing.
- `../../components/prototype-switcher.tsx` — the floating bar. Returns `null`
  when `NODE_ENV === "production"`.

`page.tsx` keeps all data fetching, polling and mutations. Only the rendered
subtree swaps, so every variant runs against real jobs and real cookie state.

## When a variant wins

Fold the winner into `page.tsx` properly — this code was written under
prototype constraints (no tests, no error handling, no accessibility pass).
Then delete this folder, the switcher, and the wiring in `page.tsx`, and push
the whole set to a throwaway branch. Record which variant won and why on the
implementation issue.
