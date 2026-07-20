import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = process.cwd();
const installer = path.join(repoRoot, "installer", "windows", "install-mcp.ps1");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ide-super-worker-installer-"));

function runPowerShell(args: string[]) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installer, ...args],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

try {
  const preset = path.join(temp, "preset.env");
  const installDir = path.join(temp, "installed");
  const configPath = path.join(temp, ".codex", "config.toml");
  const secret = "installer-secret-must-not-leak";
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    preset,
    [
      "ONEAPI_BASE_URL=https://gateway.example.com/v1",
      "ONEAPI_API_KEY=",
      "CLAUDE_MODEL=worker-model",
      "CLAUDE_CODE_MODEL=sonnet",
      `SANDBOX_ROOT=${temp.replace(/\\/g, "/")}`
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    configPath,
    [
      'model = "keep-me"',
      "",
      "[mcp_servers.codex_async_worker]",
      'command = "old-node"',
      "",
      "[mcp_servers.codex_async_worker.env]",
      'OLD_VALUE = "remove-me"',
      "",
      "[mcp_servers.unrelated]",
      'command = "keep-this"'
    ].join("\n"),
    "utf8"
  );

  const install = runPowerShell([
    "-NonInteractive",
    "-SkipPayloadInstall",
    "-SkipDependencyInstall",
    "-SkipDoctor",
    "-PresetPath", preset,
    "-InstallDir", installDir,
    "-CodexConfigPath", configPath,
    "-ApiKey", secret
  ]);
  assert.strictEqual(install.status, 0, install.stderr || install.stdout);
  assert.ok(!install.stdout.includes(secret), "secret leaked to installer stdout");
  assert.ok(!install.stderr.includes(secret), "secret leaked to installer stderr");

  const config = fs.readFileSync(configPath, "utf8");
  assert.ok(config.includes('model = "keep-me"'));
  assert.ok(config.includes("[mcp_servers.unrelated]"));
  assert.ok(config.includes('command = "keep-this"'));
  assert.ok(!config.includes("old-node"));
  assert.ok(!config.includes("OLD_VALUE"));
  assert.ok(!config.includes(secret));
  assert.strictEqual((config.match(/\[mcp_servers\.codex_async_worker\]/g) || []).length, 1);

  const installedEnv = fs.readFileSync(path.join(installDir, ".env"), "utf8");
  assert.ok(installedEnv.includes(`ONEAPI_API_KEY=${secret}`));

  const importedEnv = path.join(temp, "host.env");
  const importedInstallDir = path.join(temp, "imported-installed");
  const importedConfig = path.join(temp, "imported", "config.toml");
  fs.writeFileSync(importedEnv, `${fs.readFileSync(preset, "utf8")}\nONEAPI_API_KEY=${secret}\n`, "utf8");
  const importedInstall = runPowerShell([
    "-NonInteractive",
    "-SkipPayloadInstall",
    "-SkipDependencyInstall",
    "-SkipDoctor",
    "-EnvFile", importedEnv,
    "-InstallDir", importedInstallDir,
    "-CodexConfigPath", importedConfig
  ]);
  assert.strictEqual(importedInstall.status, 0, importedInstall.stderr || importedInstall.stdout);
  assert.ok(!importedInstall.stdout.includes(secret), "imported secret leaked to installer stdout");
  assert.ok(fs.readFileSync(path.join(importedInstallDir, ".env"), "utf8").includes(`ONEAPI_API_KEY=${secret}`));
  assert.ok(!fs.readFileSync(importedConfig, "utf8").includes(secret));

  const dryInstallDir = path.join(temp, "dry-installed");
  const dryConfig = path.join(temp, "dry", "config.toml");
  const dryRun = runPowerShell([
    "-NonInteractive",
    "-DryRun",
    "-PresetPath", preset,
    "-InstallDir", dryInstallDir,
    "-CodexConfigPath", dryConfig,
    "-ApiKey", secret
  ]);
  assert.strictEqual(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.ok(!dryRun.stdout.includes(secret));
  assert.ok(!fs.existsSync(dryInstallDir), "dry run created install directory");
  assert.ok(!fs.existsSync(dryConfig), "dry run wrote Codex config");

  const missingKeyInstall = path.join(temp, "missing-key-installed");
  const missingKeyConfig = path.join(temp, "missing-key", "config.toml");
  const missingKey = runPowerShell([
    "-NonInteractive",
    "-SkipPayloadInstall",
    "-SkipDependencyInstall",
    "-SkipDoctor",
    "-PresetPath", preset,
    "-InstallDir", missingKeyInstall,
    "-CodexConfigPath", missingKeyConfig
  ]);
  assert.notStrictEqual(missingKey.status, 0, "installation accepted an empty API key");
  assert.ok(!fs.existsSync(missingKeyInstall), "failed installation created install directory");
  assert.ok(!fs.existsSync(missingKeyConfig), "failed installation wrote Codex config");

  console.log("windows installer tests passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
