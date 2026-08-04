# Design: `aca context-footprint`

**Status:** Proposed. First check of the suite; consumes the
[suite design](suite.md) contracts (JudgeClient, change scope, verdict cache,
exit codes) and adds only what is specific to this check.

## What it judges

Each changed file, as it now stands, against the vendored
[file-context-footprint standard](../standards/file-context-footprint.md).
The judge answers the standard's own practical test: *what is the smallest set
of files a model must load to work on this concept safely and correctly?*
Both failure directions count — oversized mixed-responsibility files and
excessively fragmented abstractions. The check exists because length ratchets
punish the symptom, and a model under a ratchet relocates a blob rather than
fixes the concept; telling relocation from design requires judgment.

Tier: **T1 (judgment)** — the whole point is discrimination a mechanical
check cannot make. Routing per the consuming config's tier map (ENG-0151
pattern; registry currently seeds T1 → Anthropic `claude-opus-5`, provisional).

## Judge input, per file

The prompt embeds the **vendored rule text read from disk at runtime** — never
a paraphrase in the script, so the rule and the judge cannot drift apart.
Rule text plus judging instructions form the `system` prompt (one cached
prefix shared across every file in a run); the per-file payload is the user
turn:

1. the full file content;
2. **paths only** (not contents) of files this file imports;
3. **paths only** of files that import this file (grep of the import graph);
4. the diff hunks for this file in the current change;
5. one line: whether the file is new, grew, or shrank, with line counts.

Items 2–5 are cheap static derivations. They exist so the judge reasons about
footprint (who must load this file, what this file forces into context)
instead of guessing from content alone.

## Judge output

Structured output against a strict schema (`additionalProperties: false`, all
fields required):

```json
{
  "verdict": "pass | warn | fail",
  "practical_test_answer": "the smallest file-set a task on this concept must load, per the judge",
  "violations": [{
    "criterion": "mixed-responsibility | incomplete-concept | relocation-not-design | over-fragmentation | duplicated-context",
    "evidence": "specific, quotable observation from the file",
    "suggestion": "the concrete restructuring that would fix it"
  }],
  "reasoning_summary": "2-3 sentences max"
}
```

**Verdict semantics — the load-bearing part:**

- `fail` is reserved for clear violations the rule text names: a file that is
  enumeration/re-export ceremony over content, a file mixing concerns that are
  never changed together, a split that increased the load-set.
- **Ambiguity is `warn`, never `fail`.** A judge that fails on vibes gets the
  gate disabled within a week; a gate that warns honestly earns promotion to
  `--enforce`.
- Refusal, truncation (`stop_reason` checked before content is read), or
  schema-parse failure → `warn` with a note. Never a crash, never a silent
  pass.

## Operational bounds

One file per request; concurrency 3; `max_tokens` 4096; no sampling
parameters. Verdicts memoized per the suite cache design — a second run over
an unchanged branch makes zero API calls. Target spend: a typical 5-file
change stays under ~$0.50 on the T1 default.

## Calibration — the self-test (decision D8)

`aca context-footprint --self-test` runs the judge against golden fixtures in
`checks/context-footprint/fixtures/` and asserts expected verdicts from a
manifest. The seed pair is the worked example from the rule text itself,
captured as in-repo fixture files:

- **the enumerated union file** (~258 lines, every message type restated,
  ~120 type imports, while every domain module already exported a sub-union)
  — expected `fail`, criterion `relocation-not-design` or
  `duplicated-context`;
- **the composed version** (~58 lines, one arm per domain sub-union) —
  expected `pass`.

This is simultaneously the negative control (proof the gate *can* fail) and
the prompt-change gate: **if a fixture assertion breaks, the prompt is wrong,
not the fixture.** Iterate on the prompt until all fixtures hold, then bump
the pinned prompt-version string (which invalidates the verdict cache by
construction). CI runs the self-test whenever the prompt or fixtures change.

**D8 — golden fixtures gate prompt changes.** *Why:* an LLM judge without a
regression harness drifts silently; the self-test makes prompt quality a
tested property, and per-provider runs make D2's "supported provider" claim
falsifiable. *Downside:* fixtures can overfit — two fixtures are a floor, not
a suite; every future false positive/negative found in real use is added as a
fixture before the prompt is touched. Fixture verdicts bill real API calls,
so the self-test is on-demand and prompt-change-triggered, not per-PR.

## Consuming-repo wiring (reference, not part of this repo)

A consuming repo adds `aca.config.json` (include/exclude globs, tier map) and
a CI step running `aca context-footprint` **advisory first**. Promotion to
`--enforce` is a separate owner decision made on accumulated advisory
evidence, never bundled with adoption.
