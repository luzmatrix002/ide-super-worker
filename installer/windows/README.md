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

This MVP requires Node.js 20+, npm, Codex, and Claude Code to already be
available on `PATH`. The EXE is unsigned; Windows may show a publisher warning.

