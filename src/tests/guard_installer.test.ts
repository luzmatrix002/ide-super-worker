import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const script = path.join(root, "scripts", "install_codex_guard.ps1");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-DryRun", "-RepoRoot", root], {
    encoding: "utf8", windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  const definition = JSON.parse(result.stdout);
  assert.equal(definition.interval_minutes, 15);
  assert.equal(definition.multiple_instances, "IgnoreNew");
  assert.equal(definition.start_when_available, true);
  assert.equal(definition.execution_time_limit_minutes, 5);
  assert.match(definition.executable, /node\.exe$/i);
  assert.match(definition.arguments, /codex_guard\.mjs.*--watch/i);

  const defaultRoot = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-DryRun"], {
    encoding: "utf8", windowsHide: true
  });
  assert.equal(defaultRoot.status, 0, defaultRoot.stderr);
  assert.equal(path.basename(JSON.parse(defaultRoot.stdout).working_directory), path.basename(root));
}

console.log("guard installer tests passed");
