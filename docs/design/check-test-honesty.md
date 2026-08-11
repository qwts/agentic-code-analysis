# Design: `aca test-honesty`

**Status:** Accepted (2026-08-05, issue #15; plan and adjustments recorded on
the issue). Second check of the suite; consumes the
[suite design](suite.md) contracts (JudgeClient, change scope, verdict cache,
exit codes) and adds only what is specific to this check.

## What it judges

Each changed **test** file, one judging question:

> For each test in this file, what plausible break in the production behavior
> named by the test would make the test fail *for the right reason*?

A test that cannot fail meaningfully — asserting on its own mocks, tautologies,
`expect(true)`, snapshots nobody would read on failure — is worse than no test:
it manufactures false confidence and green CI. Coverage tools measure
execution, not whether an assertion *means* anything; telling an honest test
from a hollow one requires judgment.

**Semantics are absolute head-state**, deliberately not ACA-0013's comparative
before/after model. Comparative semantics were a context-footprint-specific
decision; making them suite-wide would be a deliberate future decision, not an
incidental copy. Recorded downside: a changed legacy test file that was always
dishonest fails here even though the change did not make it worse — the
advisory-first rollout absorbs that, and promotion to `--enforce` is where the
trade-off gets re-examined.

Blocking criteria — the only valid `fail` labels:

- `asserts-own-mock` — the oracle merely repeats behavior configured by the
  test's own mock/stub.
- `tautology` — actual and expected derive from the same source or repeat the
  same computation.
- `no-meaningful-assertion` — the test cannot discriminate the behavior in its
  name from a broken implementation.
- `unreviewable-snapshot` — the snapshot is too broad or opaque to express a
  behavior contract a reviewer can understand when it changes.

Counterexamples the rubric must encode (each is a fixture): verifying a
collaborator *interaction* can be meaningful; a focused snapshot can be
meaningful; "does not throw" can be meaningful when that is the named
contract. Out of scope: coverage sufficiency (`behavior-coverage`, backlog),
production seam quality (`mock-depth`, backlog), test-name truthfulness,
flakiness, and running the tests.

Tier: **T1 (judgment)** — routing per the consuming config's tier map
(ENG-0151 pattern; this repo currently maps T1 → Anthropic `claude-opus-5`,
provisional).

## Scope: which files are tests

A second, check-local scope stage runs after the CLI's changed-file selection
and global include/exclude filtering. Only files matching the test-file globs
are judged; everything else — changed or explicitly passed on the CLI — is
dropped before the worker pool and produces **no verdict and no judge call**.
This check never judges production files as tests.

Optional consuming-repo stanza (parsed check-locally; the core config loader
ignores unknown keys and none of the frozen contracts widen):

```json
{ "checks": { "test-honesty": { "testFiles": ["tests/**/*.ts"] } } }
```

A configured list **replaces** the defaults. An empty list or malformed stanza
is a `ConfigError` (exit 2) — never a silent way to disable the gate.

Default globs are pattern-based, not directory-based, so helpers and fixtures
colocated under a test directory are not judged as tests:

| Ecosystem | Globs | Matches | Does not match |
| --- | --- | --- | --- |
| JS/TS | `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**` | `tests/cli.test.ts`, `src/__tests__/util.js` | `tests/helpers.ts`, `src/cli.ts` |
| Python | `**/test_*.py`, `**/*_test.py` | `tests/test_scope.py` | `tests/conftest.py` |
| Go | `**/*_test.go` | `scope_test.go` | `scope.go` |
| Rust | `tests/**/*.rs` | `tests/integration.rs` | `src/lib.rs` (inline `#[test]` not seen) |
| JVM | `**/src/test/**` | `app/src/test/java/FooTest.java` | `app/src/main/java/Foo.java` |
| .NET | `**/*Test.cs`, `**/*Tests.cs` | `ScopeTests.cs` | `Scope.cs` |
| Ruby | `**/*_spec.rb`, `**/*_test.rb` | `spec/scope_spec.rb` | `spec/spec_helper.rb` |
| PHP | `**/*Test.php` | `tests/ScopeTest.php` | `tests/bootstrap.php` |

Paths are normalized and deduplicated before filtering and before the pool;
absolute and repo-escaping paths are dropped — every later read is
`join(repoRoot, file)` and must stay inside the repository.

## Judge input, per file

The human-reviewed rubric lives in one runtime-read Markdown source
(`src/checks/test-honesty/rubric.md`) — never paraphrased in code — and joins
stable judging instructions in the `system` prompt (one cached prefix per
run). The per-file user turn carries only that file's evidence:

1. the normalized test path and full test content;
2. **unit-under-test context, best effort**: direct static local imports are
   inspected (JS/TS family only in v1); paths resolving inside the repository
   that are not themselves test files or test helpers are read and their
   public export surface included, in stable order;
3. **external snapshot context, best effort**: conventionally adjacent
   snapshot files (`__snapshots__/<name>.snap`) when present and readable;
4. every unresolved, unsupported, or out-of-bound companion is represented by
   an explicit `unit exports unavailable` / `snapshot unavailable` marker —
   the judge always knows what it cannot see.

Bounds, so companion context cannot dominate the request: at most 2 unit
files and 2 snapshot files, 16 KiB per companion, 48 KiB companion total;
whatever exceeds a bound is replaced by its marker. Failure to resolve a unit
is not a finding — the judge degrades to test-file-only judgment. No build
systems, AST dependencies, module loading, or test execution in v1.

## Judge output

Strict schema (`additionalProperties: false`, all fields required):

```json
{
  "assessment": "honest | dishonest | uncertain",
  "findings": [{
    "test": "exact declared test name or source expression",
    "criterion": "asserts-own-mock | tautology | no-meaningful-assertion | unreviewable-snapshot",
    "evidence": "why this test cannot fail for the right reason",
    "meaningful_assertion": "what a discriminating assertion would establish"
  }],
  "reasoning_summary": "2-3 sentences"
}
```

The judge describes; host code decides:

| Assessment | Effective verdict |
| --- | --- |
| `honest` with no findings | `pass` |
| `dishonest` with ≥1 complete, named finding | `fail` |
| well-formed `uncertain` | `warn`, cacheable |
| `dishonest` where **all** findings are `unreviewable-snapshot` and no external snapshot content was resolvable | `warn`, cacheable — missing evidence cannot support that fail |
| malformed output, unknown criterion, empty test/evidence/meaningful-assertion, `dishonest` without findings, `honest` with findings | `warn`, **not** cacheable |

The rubric additionally instructs the judge that an external snapshot whose
content is absent must yield `uncertain`, not `dishonest`; the host guard
above is the deterministic backstop. Ambiguity is `uncertain` → `warn`, never
`fail` — a gate that fails on vibes gets disabled within a week.

The check returns a check-local subtype of `FileVerdict` (the shared contract
is not widened): `findings` retained as structured data with `test` intact,
`context` exposing the companion mode (`unit-exports` / `test-only`) and
source list so the changed-test-file bound is auditable in `--json`. The
generic text renderer is satisfied by mapping — `criterion` as labeled,
`evidence` prefixed with the test name, `suggestion` carrying the meaningful
assertion — with no test-specific behavior added to `src/cli.ts`.

## Operational bounds

One file per request; concurrency 3; `max_tokens` 32768; pinned
`PROMPT_VERSION = test-honesty-v1` (bump on any prompt or rubric change).
Input order is preserved while workers run concurrently. The cache key holds
every semantic input: prompt version, token bound, normalized test path and content,
companion context exactly as sent (sorted unit exports and snapshot content,
or their unavailable markers), rubric text, provider, model. Scope globs and
base-ref identity select work; they do not change the judgment and stay out
of the key. A second identical run makes zero judge calls; changing any
companion context misses. Transport, refusal, and schema degradations are
never cached.

## Calibration — the graded self-test (ACA-0004 D8, ACA-0012)

`aca test-honesty --self-test` runs the ACA-0012 graded exam: a
`schemaVersion: 2` manifest declaring ordered qualification levels with
per-fixture checksums and provenance, validated in full before any judge
call (a malformed or tampered package is a configuration/integrity error,
exit 2, never a judge miss). Levels grade cumulatively — one judgment per
fixture, stop after a failed level — and `--json` emits the machine-readable
qualification record (prompt version, deterministic fixture-suite identity,
achieved/required level, per-level and per-fixture results; no fixture
contents, no prompts). Always live, never cached, and run through the same
bounded pool as production judging so calibration cannot exceed the check's
own concurrency.

The **`foundation`** level (also the required level) judges golden fixtures
(`checks/test-honesty/fixtures/`, `.txt` payloads plus `manifest.json` so
they can never match test globs, the Node runner, or dogfood scope),
asserting assessment, effective verdict, required criterion, test name, and
meaningful-assertion presence:

- dependency mock configured to return a value; the test asserts that value →
  `fail` / `asserts-own-mock`;
- real behavior with a discriminating assertion → `pass`;
- expected value recomputed from the same inputs as the actual →
  `fail` / `tautology`;
- named behavior with no discriminating assertion (`expect(true)`-shaped) →
  `fail` / `no-meaningful-assertion`;
- whole-object opaque inline snapshot → `fail` / `unreviewable-snapshot`;
- meaningful collaborator-interaction mock → `pass` (counterexample);
- focused, reviewable snapshot → `pass` (counterexample);
- honest test judged with `unit exports unavailable` → `pass` (unavailable
  context must not manufacture a failure).

A **`field`** level needs a production-derived case — per ACA-0012 policy
the first production miss with agreed ground truth becomes an immutable
field fixture, with provenance and permission recorded in the manifest.
None exists yet; the gap is recorded in the manifest and `requiredLevel`
stays `foundation` until one lands, so passing today's exam is screening
evidence, not field authority.

A stub judge that always passes must make the harness test fail — the
negative control. **Prompt misses are fixed in the prompt, never by weakening
fixtures**; every prompt change bumps the pinned version.

## Consuming-repo wiring

Advisory first; promotion to `--enforce` is a separate owner decision. This
repo's own `aca.config.json` adds `tests/**` to `include` (the dogfood corpus
was previously `src/**` only) and excludes the deliberately dishonest
calibration fixtures from ordinary runs.
