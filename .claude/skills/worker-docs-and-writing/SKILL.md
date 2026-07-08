---
name: worker-docs-and-writing
description: Use when updating README, examples, operator docs, skill files, or external positioning copy for the worker project.
---

# Worker Docs And Writing

## Style

- State what is evidence and what is inference.
- Avoid claiming cheap models are reliable without checks.
- Explain defaults and blocking behavior precisely.
- Keep examples copy-pasteable and scoped.

## Required Updates

- New env var: `.env.example` and README table.
- New tool field: README example or tool surface note.
- New script: package scripts and validation section.
- New reliability behavior: mention default observe mode.

## When Not To Use

Do not use this for changing runtime behavior. Use `worker-change-control`.

## Verification

- `npm run skills:validate`
- `rg -n "<new flag or field>" README.md .env.example .claude/skills`

## Provenance and maintenance

Re-check volatile model/provider statements before publishing.
