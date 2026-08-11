# Instruction-corpus library

Issue #23. A judgment-free evidence library that maps the agent-instruction
corpus of a repository: which files exist, which tools load them, for which
sessions, in what order, at what token cost. Shared by the agent-context
check family (`agent-context-cost`, `agent-rule-conflict`, …) under the
architecture decided in
[ACA-0023](../decisions/ACA-0023-agent-context-check-architecture.md).
Convention semantics live in the source-pinned matrix,
[docs/references/instruction-conventions.md](../references/instruction-conventions.md).

## Boundary

`src/corpora/instructions/` is a pure evidence library:

- **No judging.** It never constructs a JudgeClient, reads credentials,
  builds prompts, maps verdicts, or touches the VerdictCache. No CLI
  command, no registry entry, no `CheckContext` — it does not reinterpret
  `CheckContext.files` or change-scope; each consuming check's accepted
  design decides how changed paths select work.
- **No imports from checks, core, or providers.** Its only dependencies
  are `node:` builtins and the two pinned packages below.
- **Explicit roots only.** Discovery happens inside an explicitly supplied
  repository root and explicitly authorized user roots. The library never
  calls `homedir()` and never scans an ambient home. Anything reachable
  only outside those roots (remote/org instruction stores, app-state
  rules, machine-derived paths) is reported as a documented gap or an
  unresolved binding — found where observable, never guessed.

Dependencies (the suite's first runtime dependencies, exact-pinned):
`yaml@2.9.0` for documented frontmatter (never regex-parsed YAML) and
`js-tiktoken@1.0.21` (`o200k_base`) as the reference token estimator.

## Public API

`src/corpora/instructions/index.ts` exposes exactly two operations plus
types:

```ts
discoverInstructionCorpus(request, deps?) → Promise<InstructionCorpus>
resolveInstructionSession(corpus, scenario) → SessionLoadSet   // pure
```

`CorpusRequest`: `repoRoot` (absolute), optional `userRoots`
(id + absolute path, explicitly authorized — a user root is the analog of
a home directory), optional `config` snapshot (Codex fallback filenames /
byte cap, Claude auto-memory directory, …), optional `exclude` globs
(ACA-0060 — dot-inclusive `**`/`*`/`?`/`{a,b}`, matched against every
root's root-relative POSIX paths; matches are dropped from the listing
before adapters run, and the drop is recorded as a corpus diagnostic).
Consuming checks pass the suite config's `exclude` so they judge the
corpus the config says exists; content reached only by explicit reference
(e.g. Claude `@`-imports) is unaffected — what a session genuinely loads
stays charged. `deps` injects the filesystem port and token estimator
(production defaults otherwise).

### Corpus model

All values are readonly, plain, erasable TypeScript — data only.

- **`InstructionFile`** — one physical file, read and tokenized once:
  stable `locator` (`<rootId>:<posixPath>`, never a machine-specific
  absolute path), origin root, normalized root-relative POSIX path,
  content, content kind, whole-file `TokenEstimate`, and one or more
  bindings. One file may carry bindings for several tools (the same root
  `AGENTS.md` is paid by Codex, Copilot, Cursor, and Windsurf/Devin under
  different session rules).
- **`InstructionBinding`** — one (tool, session-profile) claim on a file:
  convention id, scope predicate (root / subtree / globs / always /
  unresolved), activation phase (`session-start`, `on-path-access`,
  `model-decision`, `on-invocation`, `on-demand-resource`, `unresolved`),
  cadence (`per-session`, `per-message`, `once-on-trigger`, `unresolved`),
  charged `ContentProjection`, order relation, conflict policy, and
  `SemanticsEvidence`. Load order and conflict policy are separate
  fields: concatenation order does not imply conflicts are resolved
  (Copilot combines with **no** general precedence — that is represented
  as `unordered`, not as an invented order).
- **`ContentProjection`** — what the session actually pays for: whole
  file, selected frontmatter fields (skill/rule metadata), body,
  documented prefix/cap (Claude MEMORY.md 200-line/25 KB, Windsurf
  12k/6k chars), comment-stripped content (Claude), imported content, or
  unresolved — with the projected text and its `TokenEstimate`.
- **`SemanticsEvidence`** — `{status: "verified", source, verifiedAt}` or
  `{status: "legacy" | "unverified", reason, source?}`. "Unverified"
  means a recognized instruction candidate or legacy path whose current
  behavior is not source-verifiable (`.cursorrules`, `.windsurfrules`) —
  not arbitrary Markdown. Malformed frontmatter degrades to found +
  diagnostic, never a guessed default.
- **`TokenEstimate`** — `{count, estimated: true, estimator}` where
  `estimator` is the pinned id. Counts are estimates and say so; the
  error statement lives in the reference doc and on the corpus.
- **`InstructionCorpus`** — roots, files (stable-sorted), diagnostics,
  and the profile list.

### Session resolution

`resolveInstructionSession` takes a `SessionScenario` — profile, CWD
(repo-relative), touched paths, explicit invocations, model-selected
artifacts, accepted external imports — and classifies every binding of
that profile:

- **Confirmed contributions**, in the profile's documented order where one
  exists (Codex global→root→CWD with the byte cap applied; Claude
  root→CWD with `CLAUDE.local.md` after `CLAUDE.md` and user scope before
  project scope). Each contribution charges its projection's estimate.
- **Possible additions** — path-triggered bindings whose trigger is not in
  the scenario, model-decision bodies not in `modelSelected`, manual
  invocations not in `invoked`, approval-gated external imports not
  accepted, and every unverified/legacy binding. These are listed with
  reasons, never folded into the subtotal.
- **Totals**: `confirmedTokens` sums confirmed charged segments only
  (single estimator). `complete` is false whenever an unresolved-semantics
  binding or an unresolvable candidate touches the profile; diagnostics
  say which scenario information is missing. The resolver never
  enumerates or sums arbitrary mutually-exclusive trigger combinations.

## Discovery algorithm and safety limits

1. Validate roots (absolute, existing, no duplicates); normalize all
   paths to POSIX form. List each root **once**, in stable sorted order.
   `.git` is always skipped; `node_modules` is skipped by default and the
   exclusion is recorded as a corpus diagnostic (visible, not silent).
   Paths matching the request's `exclude` globs are dropped inside the
   listing with the same diagnostic posture — adapters never see, read,
   or tokenize a match (ACA-0060). Listing stops with a diagnostic at
   `maxEntriesPerRoot` (default 50,000); excluded paths never count
   toward the cap, so a huge excluded tree cannot blank a root's
   discovery.
2. Every convention adapter selects candidate paths from the immutable
   listing; the union is read once through a memoized source map.
   Unreadable candidates and files over `maxFileBytes` (default 1 MiB)
   become diagnostics, not crashes. A candidate that is a symlink
   resolving outside its authorized root stays unresolved.
3. Adapters run in stable id order over the snapshot. They own their
   convention's discovery, frontmatter interpretation (via the shared
   `yaml` seam), activation, hierarchy, preprocessing, and precedence.
   The Claude adapter expands `@`-imports only inside authorized roots,
   depth ≤ 4, with canonical-path containment, deduplication, and cycle
   detection; external imports in project scope surface as conditional.
4. The aggregator merges by `(origin, normalizedPath)` — one read, one
   whole-file tokenization per physical file, each binding keeping its
   own charge semantics — validates adapter output, and stable-sorts all
   public arrays so output is independent of filesystem enumeration
   order.

## Module layout

| File | Concept |
| --- | --- |
| `model.ts` | corpus/session value types and the adapter contract |
| `ports.ts` | filesystem port + injected deps |
| `node-filesystem.ts` | production filesystem adapter (bounded listing, symlink containment) |
| `discover.ts` | one-pass candidate orchestration and physical-file merge |
| `cascade.ts` | scenario resolution and deterministic totals |
| `frontmatter.ts` | the single YAML parse/projection seam |
| `paths.ts` | pure POSIX-path helpers shared by adapters and cascade |
| `token-estimate.ts` | estimator port, pinned default, segment accounting |
| `conventions/{codex,claude,copilot,cursor,windsurf,agent-skills}.ts` | one host/spec per file, each emitting its profiles |
| `index.ts` | the narrow public facade |

`agent-skills.ts` is the spec-level SKILL.md parser/validator shared by
the Claude and Windsurf adapters. Nothing is imported from
`src/checks/**` or `src/core/**`, and nothing there imports this library
until a consuming check's design is accepted.

## Testing

Fixture repo/user trees live under
`tests/fixtures/instruction-corpus/<profile-or-topic>/<case>/{repo,home}/`;
assertions live in flat `tests/instruction-corpus-*.test.ts` files (repo
convention) with an injected fake estimator so a tokenizer pin bump cannot
rewrite semantic expectations. The pinned default estimator and the
calibration corpus are tested separately. A recording filesystem proves
one list per root and one read per unique candidate. A deterministic
integration test maps this repository's tracked `AGENTS.md`; CI never
depends on an ambient home — the CLAUDE/user-memory demonstration runs
with explicit authorized roots over fixture trees.
