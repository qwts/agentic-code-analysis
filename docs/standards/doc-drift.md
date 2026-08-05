# Documentation truth: current claims must match the code they describe

Authored for this repository (issue #19). This is the truth rubric the
`doc-drift` judge embeds verbatim at runtime — human-reviewed policy, kept
separate from prompt mechanics so the rule and the judge cannot drift apart.

## The rule

A documentation file drifts when it asserts, **as current fact**, something
the code it explicitly references no longer makes true. Stale docs are worse
than missing docs because readers — human and agent — trust them. Link
checkers catch dead paths; only judgment catches dead claims.

The unit of judgment is one documentation file plus the current contents of
the code files it explicitly references. The question is absolute and
present-tense: *is what this document says about these files true of them
now?* It is never "did this change make the doc worse" — the diff only
selects which documents are worth asking about.

## What is a current-truth claim

A statement drifts only when all three hold:

1. **It is presented as current.** "The cache key includes the provider" is
   current. "In 2025 we decided X", "the first attempt enumerated every
   type", a `Superseded` decision record's original text, a proposal, a
   roadmap item, or an explicitly dated narration is historical — historical
   statements stay true when the code moves on, and never drift.
2. **It is factual and unqualified.** Hedged or aspirational text ("should",
   "eventually", "for example, one could") is not a claim about the code.
3. **The supplied evidence contradicts it.** The claim must be checkable
   against the referenced files provided. A claim about files not supplied,
   or about behavior only observable by running code, is outside this
   judgment.

## Failure criteria (closed set)

- **`claim-contradicts-code`** — an unqualified current factual claim
  conflicts with the supplied implementation or configuration (a documented
  default the code contradicts, a described behavior the code no longer has).
- **`referent-gone`** — the document presents a path, symbol, command, or
  flag as current, but the supplied tree shows it removed or renamed.
  Mentioning the old name while narrating history is not drift.
- **`example-no-longer-runs`** — a documented invocation or code example is
  structurally incompatible with the supplied current interface (removed
  flag, renamed subcommand, changed required argument). Judged statically —
  examples are never executed. A removed name *inside an invocation or
  example* is this criterion; `referent-gone` is for names presented as
  current outside examples.
- **`incomplete-new-behavior`** — the document omits material behavior the
  supplied referent now has. Incompleteness is a warning, never a failure: a
  merely undocumented feature does not make existing prose false.

## Evidence discipline

Every finding must quote the claim as it appears in the document and cite
the specific supplied code evidence that contradicts it. No finding may rest
on assumed behavior, external knowledge, or files that were not supplied.
When the supplied evidence is insufficient to support or refute a claim, the
honest answer is uncertainty, not a guess in either direction. Ambiguity
never fails.
