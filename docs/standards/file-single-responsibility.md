<!--
Repo-authored standard (issue #16). Unlike file-context-footprint.md this is
not a vendored copy of an external canonical rule — this file IS the canonical
source. The single-responsibility judge embeds this text verbatim at runtime;
edit here and bump the check's prompt version.
-->
# File organization: one reason to change per file

## The rule

A file should serve one actor: one person, team, policy, or stakeholder group
whose needs can cause the file to change. When two independent actors can each
demand a change to the same file, their requirements will drag it in different
directions — a change for one risks breaking the other, reviews need both
contexts, and the file accretes conditionals that exist only to keep the
actors out of each other's way.

This is the classic single-responsibility judgment: a responsibility is a
*reason to change*, and reasons to change belong to actors, not to code
topology. Mechanical cohesion metrics (LCOM and friends) approximate this
numerically; they cannot identify the actors, so they cannot actually make
the judgment.

The practical test is:

> Who can ask for changes to this file, and can any two of them ask
> independently? List the concrete change requests the file would receive. If
> two requests come from different actors — a presentation owner and a
> compliance owner, a protocol vendor and a product team — the file has more
> than one responsibility.

## What is NOT a violation

Judge reasons to change, never surface features:

- **Multiple functions, classes, or exports** are fine when one actor owns
  them all. A file of ten string helpers serves one actor.
- **Many imports or many callers** are fine. Being widely used is not the
  same as being owned by many actors — a date-formatting module imported by
  forty files still changes only when the formatting owner says so.
- **Cohesive orchestration is one responsibility.** A file that sequences
  parse → validate → dispatch owns the *sequence*; the steps it calls own
  themselves. Touching layers is not serving actors.
- **Technical layering alone** (this file does I/O *and* has types in it) is
  not a violation without a divergent reason to change.

## The violations

- **`multiple-actors`** — two or more identifiable actors or stakeholder
  groups can request independent changes to this file. The evidence must
  name the actors and the concrete change each would request; "this could be
  split" is not evidence.
- **`mixed-concerns`** — independent policies or technical concerns in one
  file change for different reasons, even where a distinct human actor
  boundary cannot be supported (e.g. a retry policy and a serialization
  format co-resident, each evolving on its own schedule). Where the evidence
  supports naming actors, report `multiple-actors` instead — never both from
  the same evidence.
- **`change-magnet`** — a centralized switch, registry, enumeration, or
  God-file structure forces unrelated feature additions to edit this file.
  The evidence must point at the concrete structure (the switch over every
  feature, the enum every domain extends), never at guessed change history.

## Boundary against the context-footprint standard

The [context-footprint rule](file-context-footprint.md) asks **what must be
loaded to work on this file safely** — a question about reading cost.
This rule asks **which independent pressures can change this file** — a
question about ownership. They are independent axes:

- a small, self-contained file can have a *minimal* footprint and still
  serve two actors — it passes context-footprint and fails here;
- a large protocol or composition file can be expensive to load yet owned by
  exactly one actor — it may fail context-footprint and pass here.

A file failing both rules gets one finding from each check, under each
check's own criteria. The criterion vocabularies are disjoint by design, and
neither check reports the other's axis.
