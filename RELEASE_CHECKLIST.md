# Release Checklist

- [ ] `README.md` has no private paths, provider keys, or personal gateway URLs.
- [ ] `codex-mcp.example.toml` uses placeholders only.
- [ ] `.env` is not tracked.
- [ ] `node_modules/`, `dist/`, logs, and archives are not tracked.
- [ ] `npm run build` passes.
- [ ] `npm run test` passes.
- [ ] `npm run smoke` passes.
- [ ] `npm pack --dry-run` contains only intended files.
- [ ] CI workflow is added with a token that has GitHub `workflow` scope.
- [ ] GitHub repository description and topics are set.
- [ ] First release notes mention current limitations and network credential requirements.
- [ ] Any token pasted during setup has been revoked and replaced.
