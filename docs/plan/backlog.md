# Plan: check backlog

Candidate checks for the suite, captured from brainstorm (2026-08-04) before
design. Entries here are **ideas, not commitments** — unvetted, unsized, and
not yet held to the suite's contracts. The promotion path for any entry is:

1. Backlog row (this file) — a name and the judgment it would make.
2. Design doc under `docs/design/check-<name>.md` — judge I/O, verdict
   schema, calibration fixtures, bounds (the shape
   [check-context-footprint](../design/check-context-footprint.md) set).
3. Plan issue in [issues.md](issues.md) form, filed via the shared
   feature-lifecycle on approval.

Removal is as valid as promotion: an entry that fails the judge-worthiness
test below should be deleted with a one-line note, not left to rot.

## Selection tests

Apply these before promoting an entry:

- **Judge-worthiness.** If ~90% of the check is expressible as an AST or
  regex rule, it belongs in a linter, not here. The strongest checks are
  those where the *entire* value is the judgment.
- **Corpus shape.** What evidence does the judge read, and what do
  calibration fixtures look like? Shapes used below:
  - `file` — single file plus import context; fixtures are single files
    (the `context-footprint` shape — cheapest to build and calibrate).
  - `diff` — a change; fixtures are before/after pairs (needs ACA decision,
    see below).
  - `cross` — comparison across many files/endpoints; fixtures are small
    repo slices.
  - `tests↔prod` — reads tests to judge production code or vice versa.
  - `instructions` — agent-instruction corpus (AGENTS.md, CLAUDE.md,
    copilot/cursor/windsurf rules, skills front-matter).
- **Stakes.** Checks whose false *pass* implies safety assurance (the
  secure-code group) report findings-only — pending ACA decision below.

## Cross-cutting decisions needed (before certain classes)

Three architectural questions recur across entries; each should get an ACA
record before the first check in its class is designed, per the
design-first working agreement:

1. **Diff-scoped fixture corpus.** `file`-shaped checks reuse the existing
   calibration self-test pattern. `diff`-shaped checks need before/after
   fixture pairs — a different corpus format, storage layout, and self-test
   assertion shape. Decide once.
2. **Shared evidence pass / check groups.** Several groups (dependency
   inventory for decoupling+seams; instruction-corpus discovery for the
   agent-context group) share expensive evidence gathering. Decide whether
   the architecture is one evidence pass with multiple judges over it
   (`aca <group>` running member checks) or fully independent checks.
3. **Security reporting posture.** Security-flavored checks only ever
   *raise* findings and never claim cleanliness ("no findings" ≠ "secure"),
   so a green check is never a rubber stamp.

## Backlog

### Clean code / DRY / SOLID

| Check | Judgment | Corpus |
| --- | --- | --- |
| `duplication-intent` | Semantic duplication token-based clone detectors miss: same concept to unify, or coincidental similarity to keep apart (the WET/AHA call) | cross |
| `single-responsibility` | Does this module have one reason to change / serve one actor? Sibling of `context-footprint` | file |
| `abstraction-fit` | Over-abstraction (speculative generality, one-impl interfaces) and under-abstraction (repeated type-switches begging for polymorphism) | file |
| `naming-truth` | Does the name tell the truth about behavior — `getUser()` that mutates, `isValid` that throws, names drifted after refactors | file |
| `dependency-direction` | Do imports flow the right way conceptually (domain importing HTTP handlers, core depending on adapters) with layers *inferred*, not declared | cross |
| `dead-concept` | Wired-up but abandoned features: flags never flipped, options no caller passes, error paths no input reaches | cross |

### SDLC

| Check | Judgment | Corpus |
| --- | --- | --- |
| `commit-coherence` | Is this diff one logical change or several tangled ones that should split | diff |
| `doc-drift` | README/docstring/ADR claims no longer true of the code they describe | cross |
| `decision-compliance` | Does a diff violate a recorded decision in `docs/decisions/`? Makes ADRs enforceable policy | diff |
| `api-contract-break` | Is a public-surface change semantically breaking beyond signature diffs (now-nullable returns, tightened inputs, reordered side effects) | diff |
| `review-readiness` | Leftover debug prints, commented-out code, unlinked TODOs, stray test-skips — intentional or forgotten? | diff |

### STLC / testing

| Check | Judgment | Corpus |
| --- | --- | --- |
| `test-honesty` | Tests that can't fail meaningfully: asserting on own mocks, tautologies, unreadable snapshots | file |
| `behavior-coverage` | Which of a module's *claimed* behaviors (names, docs, branches) have no exercising test — behavior coverage, not line coverage | tests↔prod |
| `test-name-contract` | Does each test's name match what its body verifies | file |
| `flakiness-smell` | Static flake risk: real timers/sleeps, order dependence, shared mutable fixtures, network reliance | file |

### UI/UX

| Check | Judgment | Corpus |
| --- | --- | --- |
| `a11y-semantics` | Beyond axe-core: is alt text meaningful, do button labels say what happens, do errors tell the user what to do next | file |
| `copy-consistency` | User-facing string voice/terminology drift ("Sign in" vs "Log in" vs "Login"), against a supplied or inferred style guide | cross |
| `state-coverage-ui` | Do components handle non-happy-path states: loading, empty, error, overflow | file |

### Cloud / ops

| Check | Judgment | Corpus |
| --- | --- | --- |
| `config-blast-radius` | Consequences of IaC/config diffs a plan output doesn't surface (exposure changes, forced replacement dropping data, defaults changing existing deployments) | diff |
| `failure-posture` | Behavior when dependencies misbehave: retries without backoff, missing timeouts, stampedes, fail-open paths | file |

### Decoupling

| Check | Judgment | Corpus |
| --- | --- | --- |
| `coupling-kind` | Not how much coupling but *what kind* — content, common, stamp, temporal — and which are legitimate | cross |
| `knowledge-leak` | What a module knows it shouldn't: callee's caching, iteration order, another module's string format, duplicated validation rules | cross |
| `event-contract` | Unstated emitter/listener assumptions in pub-sub: schemaless payloads, cross-event ordering, listener-on-listener dependence | cross |
| `interface-leak` | Public surface leaking implementation (ORM entities in returns, storage-engine errors, `redisTtl` on a generic cache) — could you swap the impl without touching callers? | file |

### Seams (testability)

| Check | Judgment | Corpus |
| --- | --- | --- |
| `seam-audit` | Which dependencies have no seam: hardwired `new`, direct clock/random/fetch/env, import-time side effects — a testability footprint | file |
| `seam-placement` | Seams in the wrong places: injection points nobody varies, seams cutting through cohesive concepts, mocks that make tests meaningless | file |
| `mock-depth` | Reads tests to grade production seams: how deep mocks reach; deep mocking as the symptom, the missing seam named as the disease | tests↔prod |

### Secure code (findings-only reporting; see decision 3)

| Check | Judgment | Corpus |
| --- | --- | --- |
| `trust-boundary` | Does validation genuinely neutralize the sink at the boundary where untrusted input crosses in — or is it assumed, duplicated, or after first use | cross |
| `authz-consistency` | Authorization applied uniformly across sibling endpoints (missing tenant check on one route, object-level checks absent where siblings have them) | cross |
| `fail-posture-security` | Error-path security: auth failing open, catch blocks continuing privileged work, secrets/PII in errors and logs | file |
| `secret-hygiene` | Secret *handling*, beyond presence scanning: CLI args, logged config objects, tokens on disk, key material in URLs | file |
| `dangerous-default` | What shipped defaults do to the user who never reads the docs: CORS `*`, `verify=false`, auth-disabled samples, bypass flags | file |

### Agent context (the corpus is consumed by LLMs — the judge is the real reader)

| Check | Judgment | Corpus |
| --- | --- | --- |
| `agent-context-cost` | Value-per-token of instruction files paid every session; nested-cascade totals in monorepos | instructions |
| `agent-discoverable` | Instructions restating what any agent trivially discovers (layout, package scripts) vs. non-derivable tribal knowledge | instructions |
| `agent-rule-conflict` | Contradictions within and across instruction files, and rule collisions with no stated priority | instructions |
| `agent-file-parity` | Semantic drift across the multi-tool matrix (AGENTS.md / copilot / cursor / windsurf); recommends consolidation | instructions |
| `agent-scope-placement` | Is each rule where its blast radius says it belongs (root vs. nested, per which sessions load what) | instructions |
| `agent-rule-followable` | Is each rule actionable, unambiguous, and checkable as an instruction to an agent; output rewrites weak rules | instructions |
| `agent-rule-enforceable-elsewhere` | Rules that should be hooks/linters/branch protection instead of prose — deterministic enforcement at zero context cost | instructions |
| `agent-instruction-drift` | Rules referencing files/scripts that no longer exist; claims git history shows are stale ("mid-migration to X", finished) | instructions |
| `agent-standing-orders` | Standing permissions for risky behavior ("skip slow tests", "use --force") — what's the worst session this rule authorizes? | instructions |
| `skill-trigger-quality` | Skill/command descriptions as routing: distinctive triggers, no overlap between skills, scope matching behavior | instructions |

## Promoted (2026-08-04)

The top 10 by bang-for-buck (dev time, benefit, run cost, breadth) were
promoted to issues, skipping the design-doc step of the promotion path only
in the sense that each issue *requires* its design doc before
implementation:

Singles (file-shaped, `context-footprint` skeleton, no prerequisites):

- `naming-truth` → [#14](https://github.com/qwts/agentic-code-analysis/issues/14)
- `test-honesty` → [#15](https://github.com/qwts/agentic-code-analysis/issues/15)
- `single-responsibility` → [#16](https://github.com/qwts/agentic-code-analysis/issues/16)
- `seam-audit` → [#17](https://github.com/qwts/agentic-code-analysis/issues/17)
- `failure-posture` → [#18](https://github.com/qwts/agentic-code-analysis/issues/18)
- `doc-drift` → [#19](https://github.com/qwts/agentic-code-analysis/issues/19)

Epics (shared infrastructure + ACA decision, then two checks each):

- Diff-scoped checks →
  [#26](https://github.com/qwts/agentic-code-analysis/issues/26)
  (corpus [#20](https://github.com/qwts/agentic-code-analysis/issues/20) →
  `review-readiness`
  [#21](https://github.com/qwts/agentic-code-analysis/issues/21),
  `commit-coherence`
  [#22](https://github.com/qwts/agentic-code-analysis/issues/22))
- Agent-context group →
  [#27](https://github.com/qwts/agentic-code-analysis/issues/27)
  (corpus [#23](https://github.com/qwts/agentic-code-analysis/issues/23) →
  `agent-context-cost`
  [#24](https://github.com/qwts/agentic-code-analysis/issues/24),
  `agent-rule-conflict`
  [#25](https://github.com/qwts/agentic-code-analysis/issues/25))

Cross-cutting decisions 1 and 2 are thereby assigned originating issues
(#20 and #23; records will be ACA-0020 and ACA-0023 per ENG-0035).
Decision 3 (security reporting posture) remains open here — no security
check was promoted in this wave.
