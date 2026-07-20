# Windows one-click installer

Build the local installer with the current `.env` as a preset:

```powershell
npm run installer:build
```

The generated file is `output/installer/IDE-Super-Worker-Setup.exe`.

The build copies non-secret values from `.env` into the local installer preset.
Values whose names contain `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or
`CREDENTIAL` are blanked. The setup UI asks for the primary API key at install
time and stores it only in the installed `.env`, never in Codex `config.toml`.

The installer:

1. installs the compiled worker under `%LOCALAPPDATA%\IDE Super Worker`;
2. installs production npm dependencies;
3. backs up and updates `~/.codex/config.toml`;
4. runs the worker doctor;
5. asks the user to restart Codex and verify with `/mcp`.

## Deploying to another Windows host

Download `IDE-Super-Worker-Offline.zip` from the GitHub Release and copy a
completed `.env` file to the target host through your approved secret transfer
channel. Extract the ZIP, then run the installer in non-interactive mode:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-mcp.ps1 `
  -NonInteractive -EnvFile C:\secure\ide-super-worker.env
```

`-EnvFile` overrides the non-secret preset and supplies `ONEAPI_API_KEY` (and
optional fallback keys). It is read only on the target host, written to the
installed `.env`, and never copied into Codex `config.toml` or printed. The
file must contain at least `ONEAPI_BASE_URL`, `ONEAPI_API_KEY`, `CLAUDE_MODEL`,
`CLAUDE_CODE_MODEL`, and `SANDBOX_ROOT`.

This MVP requires Node.js 20+, Codex, and Claude Code to already be available
on `PATH`. npm is only needed if the bundled production dependencies are
missing or damaged. The EXE is unsigned; Windows may show a publisher warning.

