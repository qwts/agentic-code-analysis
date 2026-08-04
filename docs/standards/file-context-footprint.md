<!--
Vendored copy. Canonical source:
~/Library/Mobile Documents/com~apple~CloudDocs/Agent Space/engineering-standards/file-context-footprint.md
CI and consuming agents cannot read iCloud; this copy exists so the judge can
embed the rule text at runtime. Update by re-copying the canonical file, never
by editing here.
-->
# File organization: minimal context footprint per concept

Stated by Chris, 2026-08-04. Applies to every coding agent working in his
repositories — this folder is deliberately outside any one agent's private
memory so Codex, Cursor, Devin, and Claude are all held to the same rule.

## The rule (his words, verbatim)

> A file should have the smallest practical context footprint that still
> completely represents one coherent concept.
>
> The goal is that when a model needs to understand, modify, or reuse that
> concept, it can load that file—and ideally only that file—without pulling
> unrelated implementation into context.
>
> Keep code together when it is necessary to understand or operate on the
> concept correctly. Split code when including it would force the model to
> consume unrelated responsibilities, dependencies, or change concerns.
>
> The boundary is therefore not primarily file length. It is contextual
> completeness:
>
> A file should contain all of the context required to work with one concept,
> and as little context as possible beyond that concept.
>
> A good file is independently useful, semantically complete, and narrowly
> scoped. A poor file either requires several other files to understand a basic
> concept or contains unrelated material that wastes context and increases the
> chance of incorrect edits.
>
> In model-oriented terms:
>
> * maximize semantic cohesion per token
> * minimize unrelated context pulled into the working set
> * colocate code that must be reasoned about together
> * separate code that can be understood or changed independently
> * avoid both oversized mixed-responsibility files and excessively fragmented
>   abstractions
>
> The practical test is:
>
> If the model is asked to work on this concept, what is the smallest set of
> files it must load to do so safely and correctly?
>
> The ideal answer is one focused file, except where architectural boundaries or
> genuinely shared contracts require more.

## Earlier framing of the same idea

Code belongs in one file when it: implements one cohesive concept; is difficult
to understand independently; is always changed together; shares private
implementation details; is small enough that navigation remains easy; and is not
useful outside that file.

## The failure mode this exists to correct

**Chris's diagnosis:** the criterion *"difficult to understand independently"* is
the one that breaks models. A model reads it as "one file is easier to
understand" — but that is a statement about the *model's own* context limits,
not a property of the code. Projecting that preference onto a codebase produces
exactly the tendency he named: **put everything in the file.**

Length ratchets do not fix this. They punish the symptom, and a model under a
ratchet will relocate a blob rather than fix the concept — satisfying the number
while leaving the context footprint untouched.

## Worked example — qwts/image-trail, 2026-08-04

`extension/src/background/messages.ts` hit its size ratchet at 552 lines. The
first attempt moved `ExtensionRequest` / `ExtensionResponse` into a new file:
258 lines, ~120 type imports, every individual message type enumerated. The
number went down; the footprint did not. That file failed the rule outright —
its contents were useful outside it, and touching any one message domain meant
loading all fourteen.

What the codebase already had, unnoticed: **every domain module already exported
its own sub-union** (`BlobRequest`, `BookmarkRequest`, `PanelRequest`,
`PCloudRequest`, `ImageFetchRequest`, `RecallRequest`, `UrlTemplateRequest`,
`CommonRequest`, `AlbumRequest`, `BlobKeyRequest`, `DestinationRequest`,
`OriginalBlobRequest`, `RecentHistoryRequest`). Composing from those instead of
enumerating took the file from **258 lines to 58**, and — the part that matters
— adding a message type now touches exactly one domain file, never this one.

The lesson is not "compose unions." It is that the enumeration *read* as easier
to understand because it was all in one view, which is the bias above wearing a
disguise.

## How to apply

Before splitting a file because a linter complained, answer the practical test
above. If the split does not reduce the number of files a task must load, it is
relocation, not design — and the ratchet will be back.
