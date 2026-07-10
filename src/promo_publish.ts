import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildXText,
  defaultProfilePath,
  loadManifest,
  parsePlatforms,
  type PlatformId,
  type PromoManifest,
  type PromoPost,
} from "./promo_publish_core.js";

type CliOptions = {
  manifest: string;
  platforms: PlatformId[];
  profile: string;
  session: string;
  execute: boolean;
  headed: boolean;
};

const cwd = process.cwd();

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    manifest: path.join("promo-strategy", "ide-super-worker-launch.json"),
    platforms: parsePlatforms("all"),
    profile: defaultProfilePath(cwd),
    session: "promo-login-persistent",
    execute: false,
    headed: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (arg === "--manifest") {
      options.manifest = next();
    } else if (arg === "--platforms") {
      options.platforms = parsePlatforms(next());
    } else if (arg === "--profile") {
      options.profile = next();
    } else if (arg === "--session") {
      options.session = next();
    } else if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--no-headed") {
      options.headed = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage:
  npm run promo:dry-run
  npm run promo:publish -- -- --platforms x,juejin

Options:
  --manifest <file>    Promotion manifest JSON.
  --platforms <list>   Comma-separated: x,juejin,zhihu,xiaohongshu or all.
  --profile <dir>      Persistent Chromium user-data-dir.
  --session <name>     playwright-cli session name.
  --execute            Click final publish buttons where an adapter supports it.
  --no-headed          Open browser without --headed.
`);
}

function runCli(args: string[], label: string): void {
  const baseArgs = ["--yes", "--package", "@playwright/cli", "playwright-cli", ...args];
  const command = process.platform === "win32" ? "powershell.exe" : "npx";
  const fullArgs =
    process.platform === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& ${["npx", ...baseArgs].map(psQuote).join(" ")}`]
      : baseArgs;
  const result = spawnSync(command, fullArgs, {
    cwd,
    stdio: "inherit",
    shell: false,
    timeout: 60_000,
  });

  if (result.status !== 0) {
    const detail = result.error ? `: ${result.error.message}` : "";
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}${detail}`);
  }
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function ensureBrowser(options: CliOptions): void {
  fs.mkdirSync(options.profile, { recursive: true });
  const args = ["--session", options.session, "open", "about:blank", "--browser", "chrome", "--persistent", "--profile", options.profile];
  if (options.headed) {
    args.push("--headed");
  }
  runCli(args, "open persistent browser");
}

function writeAdapterScript(platform: PlatformId, manifest: PromoManifest, post: PromoPost, execute: boolean): string {
  const outputDir = path.join(cwd, "output", "playwright", "promo-generated");
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, `${platform}.js`);
  fs.writeFileSync(file, adapterSource(platform, manifest, post, execute), "utf8");
  return file;
}

function adapterSource(platform: PlatformId, manifest: PromoManifest, post: PromoPost, execute: boolean): string {
  const payload = JSON.stringify({ manifest, post, execute, xText: buildXText(post) });
  return `async (page) => {
  const payload = ${payload};
  const log = (status, detail = "") => console.log(JSON.stringify({ platform: ${JSON.stringify(platform)}, status, detail }));
  const visibleText = async () => (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).toLowerCase();
  const loginLike = async () => {
    const url = page.url().toLowerCase();
    const text = await visibleText();
    return /login|signin|passport/.test(url) || text.includes("登录") || text.includes("sign in");
  };
  const fillFirst = async (locators, value) => {
    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        await locator.first().fill(value, { timeout: 5000 }).catch(async () => {
          await locator.first().click({ timeout: 5000 });
          await page.keyboard.insertText(value);
        });
        return true;
      }
    }
    return false;
  };
  const fillEditor = async (value) => {
    const candidates = [
      page.locator('[contenteditable="true"]'),
      page.getByRole('textbox').filter({ hasNotText: /标题|摘要|搜索/ }),
      page.locator('textarea')
    ];
    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        await locator.last().click({ timeout: 5000 });
        await page.keyboard.insertText(value);
        return true;
      }
    }
    return false;
  };

  if (${JSON.stringify(platform)} === "x") {
    await page.goto("https://x.com/intent/post?text=" + encodeURIComponent(payload.xText), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (await loginLike()) return log("needs_login", page.url());
    if (page.url().includes("graduated-access")) return log("blocked", "graduated-access");
    if (payload.execute) {
      const button = page.locator('[data-testid="tweetButton"]').last();
      if (await button.count()) {
        await button.click({ force: true });
        await page.waitForTimeout(5000);
        return log(page.url().includes("graduated-access") ? "blocked" : "submitted", page.url());
      }
    }
    return log("prepared", page.url());
  }

  if (${JSON.stringify(platform)} === "juejin") {
    await page.goto("https://juejin.cn/editor/drafts/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (await loginLike()) return log("needs_login", page.url());
    await fillFirst([page.getByPlaceholder(/标题/), page.locator('input').first()], payload.post.title || payload.manifest.projectName);
    const ok = await fillEditor(payload.post.body);
    if (!ok) return log("needs_manual_selector", "body editor not found");
    if (payload.execute) {
      const publish = page.getByText(/发布|下一步/).last();
      if (await publish.count()) await publish.click({ force: true });
      await page.waitForTimeout(3000);
      return log("submitted_or_needs_options", page.url());
    }
    return log("prepared", page.url());
  }

  if (${JSON.stringify(platform)} === "zhihu") {
    await page.goto("https://zhuanlan.zhihu.com/write", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (await loginLike()) return log("needs_login", page.url());
    await fillFirst([page.getByPlaceholder(/标题/), page.locator('textarea').first()], payload.post.title || payload.manifest.projectName);
    const ok = await fillEditor(payload.post.body);
    if (!ok) return log("needs_manual_selector", "body editor not found");
    if (payload.execute) {
      const publish = page.getByText(/发布/).last();
      if (await publish.count()) await publish.click({ force: true });
      await page.waitForTimeout(3000);
      return log("submitted_or_needs_options", page.url());
    }
    return log("prepared", page.url());
  }

  if (${JSON.stringify(platform)} === "xiaohongshu") {
    await page.goto("https://creator.xiaohongshu.com/publish/publish", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (await loginLike()) return log("needs_login", page.url());
    const longText = page.getByText(/写长文|发布笔记|图文/).first();
    if (await longText.count()) await longText.click({ force: true }).catch(() => {});
    await fillFirst([page.getByPlaceholder(/标题/), page.locator('input').first()], payload.post.title || payload.manifest.projectName);
    const ok = await fillEditor(payload.post.body);
    if (!ok) return log("needs_manual_selector", "body editor not found");
    if (payload.execute) {
      const publish = page.getByText(/发布/).last();
      if (await publish.count()) await publish.click({ force: true });
      await page.waitForTimeout(3000);
      return log("submitted_or_needs_options", page.url());
    }
    return log("prepared", page.url());
  }
}`;
}

function runPlatform(platform: PlatformId, manifest: PromoManifest, options: CliOptions): void {
  const file = writeAdapterScript(platform, manifest, manifest.posts[platform], options.execute);
  runCli(["--session", options.session, "tab-new", "about:blank"], `open tab for ${platform}`);
  runCli(["--session", options.session, "run-code", "--filename", file], `run ${platform} adapter`);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(options.manifest);
  console.log(`promo manifest: ${options.manifest}`);
  console.log(`profile: ${options.profile}`);
  console.log(`mode: ${options.execute ? "execute" : "dry-run"}`);
  console.log(`platforms: ${options.platforms.join(", ")}`);
  ensureBrowser(options);
  for (const platform of options.platforms) {
    runPlatform(platform, manifest, options);
  }
}

main();
