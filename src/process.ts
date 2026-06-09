import { spawnSync } from "node:child_process";

export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return;

  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      shell: false
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Process tree already exited.
  }
}
