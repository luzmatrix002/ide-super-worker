---
name: worker-research-frontier
description: Use when exploring frontier ideas such as dynamic tool routing, compound tools, trajectory eval, semantic gates, context decay, or skill distillation.
---

# Worker Research Frontier

## Candidate Frontiers

- Dynamic tool router: expose fewer tools to cheap models.
- Compound tools: wrap search-read-edit-test into audited primitives.
- Trajectory eval: score the path, not just the final result.
- Semantic gate: detect "checks passed but meaning is wrong".
- Skill distillation: strong sessions create verified runbooks for cheap sessions.
- Context decay meter: track failure rate against prompt and output size.

## External Signals

- Zhihu, "Claude Fable 5 系统泄漏？提示词全拆解" (`https://zhuanlan.zhihu.com/p/2048197182205998344`): use only as a secondary structural signal. The public summary says the alleged prompt is large, heavily sectioned, and policy/tool oriented; the actionable lesson is to distill durable project doctrine into skills, validators, and gates instead of stuffing one huge prompt into every worker run.
- Do not copy alleged leaked system prompt text into this repository. Extract design patterns only after restating them as repo-specific, testable rules.

## Falsifiable Result

A frontier idea has a result only when it improves a measured eval set without increasing blocking false positives beyond the chosen threshold.

## When Not To Use

Do not use this for immediate production fixes. Use `worker-campaign-cheap-reliability`.

## Verification

- Add an eval fixture or metric before changing defaults.
- Run `npm test` and the relevant stats/audit command.

## Provenance and maintenance

Label unproven ideas as candidate until measured on this repository.
