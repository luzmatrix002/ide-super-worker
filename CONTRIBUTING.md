# Contributing

Thanks for improving `mcp-codex-worker`.

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

## Design Principles

- Reduce expensive main-thread token ingestion.
- Keep the worker auditable: changed files, checks, logs, and bounded diffs.
- Prefer deterministic verification over more model calls.
- Make unsafe behavior opt-in and visible.
