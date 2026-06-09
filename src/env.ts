import * as fs from "node:fs";
import * as path from "node:path";

// Minimal, zero-dependency .env loader. Loaded as a side effect at process
// startup (imported first in index.ts/doctor.ts/setup.ts), BEFORE config.ts
// reads process.env. It NEVER overrides a variable that is already set, so the
// precedence is: real environment (Codex config.toml env / env_vars) > .env file.
// This is how plaintext secrets such as FALLBACK_API_KEY stay out of source and
// out of the tracked config, while still being available locally.
export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env file: nothing to do
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

loadDotEnv();
