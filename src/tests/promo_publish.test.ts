import assert from "node:assert/strict";
import {
  buildXText,
  defaultProfilePath,
  parsePlatforms,
  truncateCodePoints,
  validateManifest,
} from "../promo_publish_core.js";

assert.deepEqual(parsePlatforms(undefined), ["x", "juejin", "zhihu", "xiaohongshu"]);
assert.deepEqual(parsePlatforms("x,zhihu"), ["x", "zhihu"]);
assert.throws(() => parsePlatforms("x,unknown"), /Unknown platform/);

assert.equal(truncateCodePoints("abc", 10), "abc");
assert.equal(Array.from(truncateCodePoints("abcdef", 4)).length, 4);
assert.equal(truncateCodePoints("abcdef", 4), "abc…");

const xText = buildXText({
  body: "IDE Super Worker is live",
  link: "https://github.com/luzmatrix002/ide-super-worker",
  tags: ["AI", "#MCP"],
});
assert.match(xText, /IDE Super Worker/);
assert.match(xText, /https:\/\/github.com\/luzmatrix002\/ide-super-worker/);
assert.match(xText, /#AI #MCP/);

assert.throws(
  () =>
    validateManifest({
      projectName: "x",
      repository: "https://example.com",
      posts: {
        x: { body: "" },
        juejin: { body: "ok" },
        zhihu: { body: "ok" },
        xiaohongshu: { body: "ok" },
      },
    }),
  /posts.x.body/,
);

assert.match(defaultProfilePath("C:/repo").replaceAll("\\", "/"), /output\/playwright\/promo-login-profile$/);

console.log("promo publish tests passed");
