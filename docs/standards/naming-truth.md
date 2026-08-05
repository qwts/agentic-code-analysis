<!--
Authoritative source, authored in this repo (issue #14, ACA-0014) — unlike
file-context-footprint.md there is no external canonical copy to vendor.
The naming-truth check embeds this text verbatim at runtime; any edit here
changes the judge and requires bumping the check's pinned prompt version.
-->
# Naming: exported names must tell the truth about behavior

## The rule

> An exported name is a contract. It is the claim every caller reads
> *instead of* the implementation — humans skim it, models load it as the
> boundary, reviewers trust it. A name tells the truth when a reader who
> believes it is never materially wrong about what happens at runtime.
>
> The name does not have to say everything. It has to not lie.

A linter can check a name's format; only judgment can check its truth. The
moment a name lies — `getUser()` that also writes, `isValid` that throws on
invalid input, a name describing what the function did three refactors ago —
every caller who trusted it pays: wrong call sites, wrong reviews, wrong
edits by any agent that loaded the name instead of the body.

## What the rule covers

The runtime public surface a file owns:

- the **module claim** made by the file's repo-relative path (for `index.*`
  files, the owning directory's name);
- locally implemented **exported functions, callable values, and classes**,
  including the public members of exported classes;
- named, default, and CommonJS exports whose implementation is visible in
  the file.

Not covered: type-only declarations, private/protected members,
non-exported locals, and pure re-exports whose behavior lives elsewhere.
(Cross-file naming *consistency* is a different concern and a different
check.)

## The three lies

- **name-contradicts-behavior** — the name makes a falsifiable behavioral
  claim the implementation directly violates: a predicate that throws
  instead of answering on ordinary domain negatives, a `getX` that never
  returns an X, a `parseY` that only validates.
- **name-omits-side-effect** — a query-, value-, or predicate-shaped name
  hides a material caller-visible effect: mutation of arguments or shared
  state, a destructive action, persistence, network/process/file I/O, or
  event emission.
- **name-drifted** — the name still describes an obsolete or secondary
  responsibility after the implementation's primary behavior materially
  changed.

## What is not a lie

Incidental logging or metrics, memoization and caching callers cannot
observe, internal mutation invisible at the boundary, async mechanics, and
throwing on programmer-error preconditions do not by themselves belong in a
name. A vague but non-false name (`processItems`, `handleEvent`) is a style
concern, never a truth violation — vagueness under-claims; lying
mis-claims.

## Suggested names

A truthful replacement names the public contract — what a caller observes:
effects first (`recordAccessAndGetUser`, not `getUser`), honest failure
posture (`assertValidOrder` when it throws, `isValidOrder` only when it
answers). It never encodes implementation trivia a caller cannot observe.
