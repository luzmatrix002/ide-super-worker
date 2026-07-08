#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const skillsDir = path.join(root, ".claude", "skills");
const failures = [];

function fail(message) {
  failures.push(message);
}

if (!fs.existsSync(skillsDir)) {
  fail(".claude/skills does not exist");
} else {
  const entries = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (entries.length < 12) fail(`expected at least 12 skills, found ${entries.length}`);

  for (const name of entries) {
    const file = path.join(skillsDir, name, "SKILL.md");
    if (!fs.existsSync(file)) {
      fail(`${name}: missing SKILL.md`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) {
      fail(`${name}: missing YAML frontmatter`);
      continue;
    }
    const frontmatter = match[1];
    const declaredName = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (declaredName !== name) fail(`${name}: frontmatter name must equal directory name`);
    if (!description || description.length < 40) fail(`${name}: description must be trigger-rich`);
    if (!/When Not To Use|When NOT To Use|Do Not Use/i.test(text)) fail(`${name}: missing when-not-to-use guidance`);
    if (!/Verification|Provenance/i.test(text)) fail(`${name}: missing verification/provenance guidance`);
    if (/C:\\\\Users\\\\|D:\\\\知识库|private key|api key/i.test(text)) fail(`${name}: contains private or machine-specific path/secret wording`);
  }
}

if (failures.length > 0) {
  for (const item of failures) console.error(`[fail] ${item}`);
  process.exit(2);
}

console.log(`skills validation passed: ${fs.readdirSync(skillsDir).filter((entry) => fs.statSync(path.join(skillsDir, entry)).isDirectory()).length} skills`);
