---
name: worker-build-and-env
description: Use when recreating the project environment, diagnosing local setup, running tests, or checking build and Node runtime assumptions.
---

# Worker Build And Env

## Commands

```powershell
npm install
npm run build
npm test
npm run smoke
```

## Environment Checks

- `SANDBOX_ROOT` must exist and contain allowed directories.
- Gateway keys stay in env, never in tracked files.
- `WORKER_LITE_CACHE_DIR` must be inside `SANDBOX_ROOT`.
- Network checks require real gateway credentials; offline tests should not.

## When Not To Use

Do not use this for production behavior design. Use `worker-architecture-contract`.

## Verification

- `npm run doctor`
- `npm run doctor:network` when credentials are available

## Provenance and maintenance

Re-check scripts with `node -p "JSON.stringify(require('./package.json').scripts,null,2)"`.
