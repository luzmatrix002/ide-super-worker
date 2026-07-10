# IDE Super Worker 发布复盘与一键发布底座

## 本次发布经历

本次发布完成了项目改名、GitHub 仓库创建、`main` 推送、`v2.5.0` tag、GitHub Release，以及抖音文章发布。主要失败点不是内容，而是会话管理：第一次 Playwright 使用了默认 `<in-memory>` session，导致登录 cookie 没有进入预期的持久 profile。

最终修正后的浏览器 profile 路径：

```text
output/playwright/promo-login-profile/
```

后续所有发布自动化必须使用 `--persistent --profile` 启动，禁止再用默认 session 承载登录。

## 状态模型

发布器按平台记录以下状态：

- `prepared`：已打开发布器并填入内容，等待人工确认或 `--execute`。
- `submitted`：适配器确认已点击最终发布按钮。
- `submitted_or_needs_options`：已点击发布入口，但平台可能还需要分类、话题、封面、二次确认。
- `needs_login`：跳转到登录页或页面出现登录提示。
- `blocked`：平台风控或账号权限阻断，例如 X 的 `graduated-access`。
- `needs_manual_selector`：页面结构变化，当前适配器找不到编辑器。

## GitHub 底座评估

### Postiz

Postiz 是成熟的自托管社媒排程平台，覆盖 X、Bluesky、Mastodon、Discord 等，强调官方 OAuth 合规路径。它适合团队排程和长期运营，但接入成本高，且不覆盖掘金、知乎、小红书这类中文创作者后台。

### TryPost

TryPost 有日历、AI copilot、MCP server 和 REST API，定位也是完整社媒运营平台。它适合未来做“内容日历 + 审批 + 排程”，但作为本项目的一键宣传脚本过重。

### social-poster

`profullstack/social-poster` 最接近本次需要：CLI、浏览器自动化、登录 session 复用、dry-run、平台定向发布。问题是它基于 Puppeteer，覆盖主要是 X、TikTok、Pinterest、LinkedIn、Reddit、Facebook，不覆盖掘金、知乎、小红书。

### AutoCLI

AutoCLI 覆盖知乎、小红书、B站等读取场景，并强调浏览器 session 复用，但它定位是信息抓取和 agent 读取网页，不是发布器。

## 结论

没有一个现成项目同时满足：

- Playwright/Chromium 持久 profile；
- X、掘金、知乎、小红书；
- 本地 CLI 一键执行；
- 默认 dry-run；
- 不明文保存 cookie；
- 能记录平台状态。

因此本仓库新增一个轻量底座，而不是引入 Postiz/TryPost 这类重系统。

## 使用方式

先确保已经用持久 profile 登录：

```powershell
npx --yes --package @playwright/cli playwright-cli --session promo-login-persistent open about:blank --browser chrome --headed --persistent --profile "D:\知识库\_Areas（长期领域）\mcp-codex-worker-rewrite\output\playwright\promo-login-profile"
```

Dry-run，只打开页面并尝试填充：

```powershell
npm run promo:dry-run
```

只跑部分平台：

```powershell
npm run promo:dry-run -- --platforms x,juejin
```

真正点击发布按钮：

```powershell
npm run promo:publish -- --platforms x,juejin,zhihu,xiaohongshu
```

内容源：

```text
promo-strategy/ide-super-worker-launch.json
```

## 安全规则

- 不使用 `state-save` 导出 cookie JSON。
- 不调用 `cookie-list` 打印 cookie。
- 不保存密码、验证码、token 明文。
- 所有登录态只保存在 Chromium profile 里。
- 默认 `promo:dry-run` 不点击最终发布。
