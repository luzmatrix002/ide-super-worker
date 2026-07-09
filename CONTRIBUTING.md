# Contributing

Thanks for improving `ide-super-worker`.

## Development

```powershell
npm install
npm run build
npm run test
npm run smoke
```

`doctor:network` requires real gateway credentials and may fail in CI or offline environments.

## Pull Request Checklist

- Keep changes scoped.
- Add or update tests for behavior changes.
- Do not commit `.env`, generated archives, `node_modules`, or private gateway URLs.
- Run `npm run build`, `npm run test`, and `npm run smoke`.
- Mention any network-only checks that could not be run.

## Originality Policy

- All submitted code must be your own original work, or clearly attributed to
  its source with proper license compliance.
- Do not copy code from other projects without verifying license compatibility
  and adding attribution comments.
- If you adapt an algorithm or pattern from a paper or external source, cite it
  in a code comment (see `src/reasoning.ts` for an example).
- PRs that appear to contain plagiarized code will be rejected.

## Design Principles

- Reduce expensive main-thread token ingestion.
- Keep the worker auditable: changed files, checks, logs, and bounded diffs.
- Prefer deterministic verification over more model calls.
- Make unsafe behavior opt-in and visible.
