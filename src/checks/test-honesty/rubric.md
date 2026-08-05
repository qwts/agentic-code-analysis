# Test-honesty rubric

The judging question, for each test in the file:

> What plausible break in the production behavior named by this test would
> make the test fail *for the right reason*?

A test is **dishonest** when no such break exists — when the test goes green
regardless of whether the behavior it names works. A test is **honest** when
its assertions discriminate the named behavior from a broken implementation.

## Blocking criteria (the only valid finding labels)

- **asserts-own-mock** — the oracle merely repeats behavior configured by the
  test's own mock or stub: the test tells a fake what to return, then asserts
  the fake returned it. The production code is never on the hook.
- **tautology** — actual and expected derive from the same source or repeat
  the same computation: comparing a value with itself, or computing the
  expected value by calling the unit under test.
- **no-meaningful-assertion** — the test cannot discriminate the behavior in
  its name from a broken implementation: `assert(true)`-shaped assertions,
  asserting only that a value exists, or exercising code with no assertion
  about the named behavior at all.
- **unreviewable-snapshot** — the snapshot is too broad or opaque to express
  a behavior contract a reviewer can understand when it changes: whole-object
  dumps, serialized internals, or blobs nobody would read on failure.

## Counterexamples — these are honest; do not flag them

- **A collaborator-interaction assertion can be meaningful.** Asserting that
  the unit drove its collaborator correctly — called it N times, with the
  right arguments, in the right order — tests the unit's interaction
  contract. The dishonest variant asserts what the mock was *configured to
  return*; the honest variant asserts what the unit *did to* the
  collaborator.
- **A focused snapshot can be meaningful.** A small, readable snapshot that
  a reviewer can evaluate as a behavior contract when it changes is a
  legitimate oracle.
- **"Does not throw" can be meaningful** when not throwing is the named
  contract (e.g. "accepts legacy config without error").

## Evidence discipline

- Judge only what you can see. If the unit under test's exports are marked
  unavailable, judge the test file on its own terms; unavailable context is
  never itself grounds for a finding.
- An external snapshot whose content is marked unavailable cannot support an
  `unreviewable-snapshot` finding: you cannot call unreviewable what you
  cannot see. If that missing evidence prevents any defensible overall
  judgment, assess `uncertain`.
- Every finding must name the exact test and state why it cannot fail for
  the right reason, with the assertion or mock wiring quoted or precisely
  described.
- Ambiguity is `uncertain`, never `dishonest`. Only assess `dishonest` when
  you can state the false oracle concretely.

## Out of scope — never the basis of a finding

Whether coverage is *sufficient*; whether test names are accurate; flakiness
or timing; the production code's seam or mockability quality; test style,
duplication, or organization. A file with no test declarations at all is
simply `honest` with no findings — corpus selection is the host's job.
