# ACA-0064: Qwen reasoning budgets stay behind the frozen JudgeClient port

**Status:** Accepted
**Date:** 2026-08-05
**Issue:** #64
**Extends:** [ACA-0003](ACA-0003-suite-contracts.md) D2 (provider-agnostic
JudgeClient) and D6 (provider/model routing), and
[ACA-0011](ACA-0011-gate-down-classification.md) (provider-specific account
rejection)

## Context

`JudgeRequest.maxTokens` was designed as the amount of structured answer a
check permits. The shared OpenAI-wire adapter sends that value as
`max_completion_tokens`. Qwen's OpenAI-compatible API gives the latter a
different boundary: it includes both chain-of-thought and the visible answer.
A thinking model can therefore consume the entire allowance before producing
the JSON verdict, even when its advertised output and reasoning capacities are
much larger.

The behavior was observed while screening `qwen3.8-max-preview` against
`skill-information-architecture-v5`. Default thinking exhausted the 4,096
combined-token allowance and returned no verdict after 102.13 seconds.
Disabling thinking produced a valid route but achieved only `foundation`
against required `boundaries`. Giving thinking its own bounded allowance also
achieved only `foundation`; that run took 66.59 seconds. Neither route is
qualified.

The implemented adapter was then exercised directly, without the measurement
proxy. It returned strict-schema verdicts and completed in 65.20 seconds, but
still achieved only `foundation`: it passed one of four coverage controls and
missed the other three. Transport compatibility therefore did not change the
routing decision.

Qwen documents separate controls for these meanings: `max_tokens` limits the
answer without limiting chain-of-thought, while `thinking_budget` limits the
thinking phase. See the official
[OpenAI-compatible Chat API](https://docs.qwencloud.com/api-reference/chat/openai-chat)
and [thinking guide](https://docs.qwencloud.com/developer-guides/text-generation/thinking).

## Decision

**Keep the port frozen.** `JudgeClient.judge({system, user, schema,
maxTokens})` does not gain provider-specific reasoning fields. `maxTokens`
means the maximum visible structured answer, not a combined hidden-reasoning
and answer allowance. Checks continue to own that bound.

**Fork a Qwen adapter instead of widening the shared OpenAI transport.** The
adapter sends strict JSON-schema output and maps one request deterministically:

- `max_tokens = request.maxTokens` for the visible answer;
- `enable_thinking = true`;
- `thinking_budget = request.maxTokens` for hidden reasoning.

The equality is a bounded transport policy, not a claim that reasoning and
answer lengths are interchangeable. It prevents an unbounded provider default
without introducing another configuration dimension. A future change to that
mapping is a new inference profile and requires a new decision and live
qualification evidence.

**Expose no hidden inference knobs.** The adapter resolves only the explicit
`QWEN_API_KEY` and `QWEN_BASE_URL` environment variables. It does not borrow
OpenAI credentials or endpoint settings, infer an account plan, accept a
reasoning-effort override, or silently fall back to another model or route.
The configured provider/model remain the route and cache identity.

**Classify Qwen account rejection from its own wire contract.** HTTP 401, 402,
and 403 remain gate-down, as do Qwen's unambiguous `Arrearage`,
`CommodityNotPurchased`, `PrepaidBillOverdue`, and `PostpaidBillOverdue`
codes. Qwen documents 429 `insufficient_quota` for both exhausted plan quota
and TPS/TPM throttling, so that ambiguous shape remains transient instead of
inheriting ACA-0011's OpenAI-specific gate-down meaning. See Qwen's official
[error messages](https://docs.qwencloud.com/api-reference/preparation/error-messages).

**Calibration remains authoritative.** Adapter compatibility establishes only
that a request can return a strict verdict. Every exact check, prompt version,
fixture suite, provider, and model tuple must still reach the check's required
qualification level before its verdicts are trusted. The measured Qwen route
remains unqualified and must not be promoted or substituted for the qualified
route.

## Why

The check knows how much JSON its schema may need; the provider adapter knows
whether hidden reasoning shares that allowance. Keeping those responsibilities
on their respective sides preserves model interchangeability without reducing
every provider to Qwen's wire semantics. Deriving the reasoning allowance from
the existing request also keeps spend reproducible and ensures that two runs
with the same recorded route do not differ because of an unrecorded setting.

## Consequences

The Qwen adapter deliberately duplicates a small amount of OpenAI-wire
transport code. That duplication is the cost of preserving the load-bearing
port and avoiding provider branches in the shared adapter. Qwen's deprecated
`max_tokens` field remains necessary because it is the documented field with
the answer-only semantics ACA needs; compatibility must be reverified if Qwen
changes or removes it.

A check may still choose 4,096, 8,192, or another visible-answer budget in its
own design. Changing that bound or the Qwen mapping changes the inference
profile and requires cache invalidation plus requalification; it is not a
runtime tuning operation. The bounded-thinking result above is useful model
evidence, but `foundation / boundaries` is an explicit failure, not a partial
endorsement.
