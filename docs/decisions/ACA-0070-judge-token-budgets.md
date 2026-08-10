# ACA-0070: One raised judge token budget for every check and every route

**Status:** Accepted
**Date:** 2026-08-10
**Issue:** #70
**Extends:** [ACA-0003](ACA-0003-suite-contracts.md) D2 (provider-agnostic
JudgeClient) and D7 (content-addressed verdict cache)
**Narrows:** [ACA-0064](ACA-0064-qwen-reasoning-budgets.md) — its diagnosis and
its frozen-port rule stand; its remedy no longer needs to be Qwen-specific

## Context

Every check owned a private answer allowance: 4,096 tokens for ten of the
twelve, 8,192 for `doc-drift` and `agent-rule-conflict`, which had already
outgrown the smaller number on reference-heavy inputs.

ACA-0064 established that this value means different things on different
wires. Anthropic's `max_tokens` and Qwen's `max_tokens` bound the visible
answer; OpenAI's `max_completion_tokens` bounds hidden reasoning **plus** the
visible answer. A thinking model on the OpenAI wire therefore spends the
allowance reasoning and returns `finish_reason: length`, which the adapter
reports as `judge output truncated at max_tokens`, or a half-written body that
fails the strict-schema parse.

ACA-0064 fixed that for one vendor by forking a Qwen adapter and left
"OpenAI, Anthropic, and local/Gemma behavior untouched" (PR #65). Two
consequences followed. The route the fork enabled did not qualify —
`qwen3.8-max-preview` reached `foundation` where `skill-information-architecture`
requires `boundaries`. Meanwhile the route actually used for dogfooding, the
Hugging Face router reached through `ACA_PROVIDER=openai`, kept truncating:
intermittent paraphrased excerpts and schema-parse failures on
`moonshotai/Kimi-K2-Instruct-0905` were recorded as route variance when they
match budget exhaustion exactly.

The distinguishing property was never the vendor. It is whether a wire counts
hidden reasoning against the same number, and that is true of DeepSeek, of
Kimi's thinking variants, and of OpenAI's own reasoning models.

## Decision

**One bound, raised, for every check: 32,768 tokens.** `MAX_TOKENS` stays a
per-check constant in each `judge-io.ts`, so a check may still argue for more
later, but the suite no longer ships two tiers of allowance for a distinction
that no longer holds.

**The bound is a ceiling, not a purchase.** Providers bill tokens actually
emitted, so a check whose verdict is 300 tokens costs the same under 32,768 as
under 4,096. The raised ceiling buys headroom for hidden reasoning on wires
that share it, and costs nothing on wires that do not.

**No prompt-version bump, and no new cache-key component.** A verdict produced
under the old ceiling was produced *because the model stopped before reaching
it* — a raised ceiling cannot retroactively change a completion that never hit
the cap. Truncated responses were already non-cacheable failures. Existing
cache entries and existing recorded qualifications therefore remain valid, and
the Anthropic qualification the suite paid for is not revoked.

**The Qwen adapter keeps its separate thinking budget.** Its
`thinking_budget = request.maxTokens` mapping now derives from the raised
constant, which is strictly more headroom, not a change of policy.

**32,768 is a bound, not a claim about any model's capacity.** A model whose
maximum output is lower will reject the request, and the adapter surfaces that
as a visible `api error` note rather than a silent truncation. That is the
intended failure: a route that cannot accept the suite's bound is a route
qualification must catch, not one the transport should quietly reshape.

## Why

The previous shape optimized for wire fidelity — each provider's exact
semantics expressed by a dedicated adapter — at the cost of leaving the common
path broken for every reasoning model except one. Raising a ceiling that costs
nothing when unused is a smaller change than a vendor adapter per wire, it is
uniform across the suite, and it makes cheap-route screening measure judgment
quality instead of measuring truncation.

The narrow reading of ACA-0064 remains correct: the port stays frozen, checks
keep owning their bound, and no reasoning-effort knob is exposed. What changes
is that the bound is now large enough that the distinction between the two wire
meanings stops determining whether a route can answer at all.

## Consequences

- Cheap reasoning routes become screenable; qualification still governs use.
- A model with a lower output maximum fails loudly at judge time.
- Runaway generation is bounded by 32,768 rather than 4,096 per request, so a
  pathological verdict costs more than before; graded self-tests and the
  advisory-first posture remain the controls on that.
- `doc-drift` and `agent-rule-conflict` no longer need a private exception.
