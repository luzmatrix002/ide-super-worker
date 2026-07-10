import * as fs from "node:fs";
import * as path from "node:path";

export const platformIds = ["x", "juejin", "zhihu", "xiaohongshu"] as const;
export type PlatformId = (typeof platformIds)[number];

export type PromoPost = {
  title?: string;
  summary?: string;
  body: string;
  link?: string;
  tags?: string[];
};

export type PromoManifest = {
  projectName: string;
  repository: string;
  releaseUrl?: string;
  posts: Record<PlatformId, PromoPost>;
};

export function isPlatformId(value: string): value is PlatformId {
  return (platformIds as readonly string[]).includes(value);
}

export function parsePlatforms(value: string | undefined): PlatformId[] {
  if (!value || value.trim() === "all") {
    return [...platformIds];
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const invalid = parsed.filter((item) => !isPlatformId(item));
  if (invalid.length > 0) {
    throw new Error(`Unknown platform(s): ${invalid.join(", ")}`);
  }

  return parsed as PlatformId[];
}

export function truncateCodePoints(value: string, maxLength: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) {
    return value;
  }
  return `${chars.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

export function buildXText(post: PromoPost): string {
  const parts = [post.body.trim()];
  if (post.link) {
    parts.push(post.link);
  }
  if (post.tags?.length) {
    parts.push(post.tags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" "));
  }
  return truncateCodePoints(parts.filter(Boolean).join("\n\n"), 260);
}

export function loadManifest(filePath: string): PromoManifest {
  const absolute = path.resolve(filePath);
  const raw = fs.readFileSync(absolute, "utf8");
  const parsed = JSON.parse(raw) as PromoManifest;
  validateManifest(parsed, absolute);
  return parsed;
}

export function validateManifest(manifest: PromoManifest, source = "manifest"): void {
  if (!manifest.projectName || !manifest.repository || !manifest.posts) {
    throw new Error(`${source} must include projectName, repository, and posts`);
  }

  for (const platform of platformIds) {
    const post = manifest.posts[platform];
    if (!post?.body?.trim()) {
      throw new Error(`${source} missing posts.${platform}.body`);
    }
  }
}

export function defaultProfilePath(cwd: string): string {
  return path.join(cwd, "output", "playwright", "promo-login-profile");
}
