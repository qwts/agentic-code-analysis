# Design: `aca doc-drift`

**Status:** Proposed with the implementation PR (issue #19; the issue's
implementation plan called for a docs-only design PR first — collapsed to one
PR by owner instruction, design authored before source). Consumes the
[suite design](suite.md) contracts (JudgeClient, verdict cache, exit codes)
and adds only what is specific to this check.

## What it judges

Whether a documentation file's **current-truth claims** still hold against
the code files it explicitly references, per the runtime-read
[doc-drift truth rubric](../standards/doc-drift.md). The unit of judgment is
one document plus a mechanically selected bundle of its changed referents'
current contents. The judgment is absolute and present-tense; the diff only
selects which documents are affordable to inspect. This is deliberately the
file-corpus calibration contract from issue #19, not ACA-0013's comparative
`new/legacy` semantics — base content is read solely to detect that a
referenced name disappeared. Recorded downside, accepted for v1: an absolute
judgment can surface pre-existing drift ("legacy debt") in a doc swept in by
an unrelated referent change; findings are advisory until promotion, and a
regression-only variant would need the diff-corpus epic's calibration format.

Tier: **T1** (the mechanical scanner inside the check is T2-shaped work; the
issue sets the tier by the harder half). Routing per the consuming config's
tier map; no model names in code.

## Document scope (check-local config)

Doc corpus: **tracked** files (`git ls-files`) matching the check's own
globs — an untracked or generated Markdown file under an in-scope glob is
not documentation the repo ships and never bills a judge call — default
`README.md` + `docs/**/*.md` — read from the `checks.doc-drift` section of
`aca.config.json` by the check itself (the shared `core/config.ts` stays
frozen; unknown keys there are already tolerated):

```json
{ "checks": { "doc-drift": { "include": ["README.md", "docs/**/*.md"], "exclude": [] } } }
```

A configured `include` replaces the default. An empty include, or a
non-string-array value, is a `ConfigError` (exit 2) — never a silent
disable. Agent-instruction corpora are hard-excluded in v1 regardless of
globs (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, anything under `.claude/`,
`.cursor/`, or `.github/instructions/`, and `copilot-instructions.md`): the
agent-context epic owns that corpus and its cascade semantics. Docstrings,
external URLs, command execution, and auto-fixing are out of scope.

`CheckContext.files` is the **changed-referent seed set**, not the document
corpus: positional CLI paths mean "treat these paths as changed referents"
for local iteration. A changed document alone spends no judge call — at
least one extracted reference must intersect a changed referent.

## Change index (check-local, merge-base aware)

The shared selector intentionally omits deletions, and `referent-gone`
requires them, so the check builds its own index from one rename-aware
`git diff --name-status` against the merge-base (resolved once; failure is a
run-level `ConfigError`, exit 2). It records added/modified/deleted state
and both sides of a rename, applies the repo's **global** include/exclude to
the deleted and renamed-away paths it contributes (mirroring what the
dispatcher already applied to `CheckContext.files`), reads base text only to
match tokens that disappeared, and hands the evidence builder current head
content, a rename target, or an explicit absent marker. A seed path outside
the diff is treated as a changed referent as-is (local iteration). An
unreadable file that still exists is insufficient evidence — a non-cacheable
`warn` for the affected document, never inferred as deleted.

## Reference extraction (mechanical prefilter)

A pure Markdown scanner (`scanMode: "explicit-markdown-references"`)
recognizes only explicit syntax; the judge never searches the repository:

- **Paths** — local Markdown link destinations (resolved relative to the
  document, anchors/line fragments stripped; schemes, absolute paths, and
  traversal outside the repo rejected; URLs never fetched) and
  repo-relative path literals in inline or fenced code. A path referent may
  be any tracked repo file — docs reference docs, and a moved design doc is
  drift like a moved source file.
- **Symbols** — code-formatted identifier tokens (≥ 3 chars).
- **Flags** — `--long-flag` tokens in inline or fenced code.
- **Commands** — the first two command-shaped words of inline-code
  invocations and of lines in `sh`/`bash`/`shell`/`console`/`zsh` fences
  (`aca doc-drift` records the command and its subcommand; leading `$`/`>`
  prompts are stripped, shell comment lines are skipped).

Path references match when the resolved path is a changed referent (either
side of a rename). Symbol/flag/command tokens match by exact word-boundary
occurrence in a changed referent's head **or base** text — a base-only match
is how a removed token becomes a candidate. Every match is a record with a
stable id (`r1…`, ordinal after sorting), kind, literal, document line,
referent path/status, and any rename destination; records are deduplicated
per (kind, literal, referent). False-positive candidates can cost a judge
call but cannot fail without semantic evidence.

**Known misses, part of the contract:** prose-only references, dynamically
generated names, nonliteral aliases, semantic references with no explicit
token, unsupported Markdown constructs, files outside the configured globs.
Only candidate documents produce verdicts — a run's output reports findings
over candidates and never claims all documentation is current; `--json`
carries `scanMode`, the selected reference records, and referent statuses
per verdict for audit.

## Judge input / output

One `JudgeClient.judge(...)` call per candidate document. System prompt:
the rubric verbatim plus judging mechanics (one cached prefix per run). User
payload: the full current document, the reference records, and the selected
referents' current contents or absent/renamed markers — all treated as
untrusted evidence, never as instructions; nothing is executed or fetched.

Strict schema (`additionalProperties: false`, all fields required):

```json
{
  "assessment": "aligned | drifted | incomplete | uncertain",
  "findings": [{
    "criterion": "claim-contradicts-code | referent-gone | example-no-longer-runs | incomplete-new-behavior",
    "claim": "the document's claim, quoted or precisely located",
    "reference_ids": ["r1"],
    "evidence": "the specific supplied code evidence",
    "suggestion": "the documentation fix"
  }],
  "reasoning_summary": "2-3 sentences"
}
```

Host code validates nonblank claim/evidence and that every `reference_id`
names a supplied record, then maps deterministically:

| Judge result | Effective verdict |
| --- | --- |
| `aligned`, no findings | `pass` |
| `drifted` with ≥ 1 blocking criterion (first three) | `fail` |
| `incomplete` with only `incomplete-new-behavior` findings | `warn`, cacheable |
| well-formed `uncertain` | `warn`, cacheable |
| refusal, truncation, malformed schema, unknown reference id, blank claim/evidence, `drifted` without a blocking finding, `incomplete` with a blocking finding, `aligned` with findings | `warn`, **not** cacheable |

A merely undocumented new feature never fails. Historical narration,
proposals, and superseded records never fail unless represented as current
truth. Findings map onto the generic `Violation` fields for text output
(claim folded into evidence); the check-local `DocDriftVerdict` subtype
retains assessment, claim, line, reference ids, referents, and scan coverage
for `--json` — the shared `FileVerdict` contract is not widened and the
generic renderer learns nothing new.

## Operational bounds and cache identity

One request per candidate document; stable document order; concurrency 3;
`maxTokens` 32768, the suite-wide bound of [ACA-0070](../decisions/ACA-0070-judge-token-budgets.md).
This check was the first to outgrow the original 4096, which truncated structured output on
reference-heavy docs in the first live dogfood run. Hard caps per document: **12 selected referents** and
**128 KiB of UTF-8 referent evidence**; overflow is an explicit
non-cacheable `warn` naming the cap, never silent truncation. Pinned
`PROMPT_VERSION = doc-drift-v1` and `EXTRACTION_VERSION =
doc-drift-extract-v1`; any prompt change fixes the prompt (never fixtures)
and bumps the version.

Cache key (`.cache/aca/doc-drift/`), every semantic input: prompt +
extraction versions, document path + content, sorted reference records, each
selected referent's path + status + rename target + head content or absent
marker, rubric text, provider, model. Deliberately excluded: doc globs, base
ref/SHA, unrelated changed paths — they select work, they do not affect this
document's truth. Identical semantic input on a rerun makes zero judge
calls; changing any component misses.

## Calibration — graded self-test

`aca doc-drift --self-test` follows ACA-0012's exam shape, forked
check-locally (checks never import each other): a validated
`fixtures/manifest.json` (checksums, bare in-directory names, no vacuous
levels — malformed is exit 2 before any judge call) declaring cumulative
levels over synthetic doc + referent-bundle pairs in the file-corpus style
(the manifest supplies the changed-referent seed; no before/after diffs):

- **`foundation`** — the issue's discriminating pair: a doc claiming a
  default the code contradicts → `drifted`/`fail` with
  `claim-contradicts-code` and a valid reference id; the aligned pair →
  `aligned`/`pass`. An always-pass judge must miss.
- **`discrimination`** — a removed referent (`referent-gone`), a CLI example
  using a removed flag (`example-no-longer-runs`), newly added behavior
  omitted from truthful docs (never `fail`), an ADR narrating history
  (never `fail`), and a cross-module symbol collision — a doc bound to an
  unrelated changed module by a token coincidence must not fail (encodes a
  cheap judge's observed 2026-08-05 field miss).

Required level: `discrimination`. Fixtures run through the real extraction,
evidence assembly, judging, and mapping (the git change index is
unit-tested separately); the extraction must yield the expected candidate
before any judge call, or the run is an integrity error, not a judge miss.
Always live, never cached; misses are prompt bugs — fix the prompt, bump the
version, never weaken fixtures.

## Dogfood

This repo's own `README.md` + `docs/` are in scope from day one. Acceptance
evidence: temporarily seed a contradictory claim in a real in-scope doc, run
`aca doc-drift --json` advisory showing the reference match, one judge call,
and the named failure — then revert the seed; no known-stale documentation
ships. Synthetic fixtures are excluded from the repo's ordinary
self-application scope.
