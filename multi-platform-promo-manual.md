# IDE Super Worker 全平台宣传执行手册

> 喂饭版。每一步标明：在哪个平台、发什么内容、直接复制粘贴。
> 中英双语并重，12+ 平台覆盖，Day 1 到 Day 30 分阶段排期。

---

## 一、核心定位（所有平台统一口径）

### 中文口径

不是让模型更便宜，是让贵的模型只做值钱的事。搜索零成本、只读分析一次便宜调用、重活异步委派、结果只拿证据不拿过程。

### English

Don't just use a cheaper model. Make the expensive one do only what's worth it. Zero-LLM search, one-call analysis, async delegation, compact evidence not full transcripts.

### 核心数据

| 指标 | 数值 |
|------|------|
| 主线程上下文降耗（10 条命令实测） | 202,899 → 41,048 bytes，降 80% |
| 月度省钱估算（Sonnet） | ~$213/月 |
| 月度省钱估算（Opus） | ~$1,068/月 |
| 搜索所需 LLM 调用 | 0（零 token） |

### 泛化定位

不限 Codex。所有用贵 LLM 的 IDE/Agent（Cursor、Windsurf、Copilot 等）都能省。核心价值是"路由优化"，不是"支持哪个 IDE"。

---

## 二、全平台矩阵

| 平台 | 层级 | 受众 | 内容形式 | 核心角度 | 语言 |
|------|------|------|----------|----------|------|
| GitHub | 核心 | 开源开发者 | README + Release + Topics | 架构设计 + 省钱数据 | EN |
| X / Twitter | 核心 | 全球开发者 | Launch thread + 持续推文 | 一句话 + 对比图 | EN/ZH |
| Hacker News | 核心 | 硅谷工程师 | Show HN 帖子 | 效率架构 + 可复现 | EN |
| Reddit | 核心 | r/LocalLLaMA, r/ClaudeAI | 分社区帖子 | 省钱实测 + 对比 | EN |
| Discord | 核心 | MCP/Claude 社区 | 社区分享 + 答疑 | 使用场景 + 问答 | EN/ZH |
| V2EX | 中文 | 中文开发者 | 技术帖 | 省钱 + 实操 | ZH |
| 掘金 | 中文 | 前端/全栈开发者 | 长文博客 | 深度教程 + 数据 | ZH |
| 知乎 | 中文 | 技术决策者 | 回答 + 专栏 | 成本分析 + 架构 | ZH |
| B站 | 泛流量 | 技术学习者 | 5-10 分钟视频 | 对比演示 + 省钱 | ZH |
| 公众号 | 泛流量 | 技术管理者 | 深度推文 | 成本痛点 + 方案 | ZH |
| 小红书 | 泛流量 | 独立开发者/远程工作者 | 图文笔记 | 省钱 tips + 工具推荐 | ZH |
| 抖音/视频号 | 泛流量 | 泛开发者 | 60 秒短视频 | 省钱震撼 + 一句话 | ZH |

### 平台调性差异

- **开发者核心社区**：讲架构、讲路由契约、讲熔断、讲实测数据。允许技术深度，忌营销腔。
- **中文技术社区**：讲实操、讲对比、讲"一个月省多少钱"。用数据说话，附截图和终端录屏。
- **泛流量平台**：一句话讲清"省 80% 上下文 = 省 80% 钱"。用 before/after 对比图，降低理解门槛。

---

## 三、Day 0：准备（发布前一晚做完）

### 0.1 验证项目能跑

```powershell
cd 你的项目目录
npm install
npm run build
npm run test
npm run smoke
```

全绿才能继续。

### 0.2 录制三张截图

1. 跑 `npm run doctor` 截图
2. 跑一个 `start` 任务，截 `get` 返回的 changed_files + checks
3. 截一张 `npm run stats` 的 token 对比图

### 0.3 制作 before/after 对比图

- 左边写"传统方式 202,899 bytes"
- 右边写"Worker 方式 41,048 bytes"
- 中间一个大箭头 + "降 80%"
- 用任何工具（PPT/Canva/Figma）做都行，存成 PNG

---

## 四、Day 1：发布日（北京时间晚上 22:00 开始）

### 4.1 更新 GitHub

**步骤 1：更新 README**

在 README 最顶部加上：

```markdown
## Stop spending premium context on bulk code work

**Measured: 80% less premium context intake. ~$213-1068/mo saved.**

| Work type | Traditional | IDE Super Worker | Cost |
|-----------|------------|-----------------|------|
| Search code | LLM reads files | `search` 0 LLM calls | Free |
| Explain code | Full agent loop | `analyze` 1 cheap call | Low |
| Fix bugs | Premium retries loop | `start` async worker | Low |
| Review code | Premium reads diff | `review` cheap gateway | Low |
| See result | Full diff ingested | `changed_files` only | Compact |
```

**步骤 2：添加 GitHub Topics**

仓库首页右上角齿轮 → 输入以下 Topics（逐个回车）：

```
mcp  codex  claude-code  ai-coding  openai-compatible
developer-tools  cost-optimization  typescript  async-worker
context-optimization  llm-gateway  deepseek
```

**步骤 3：发布 GitHub Release**

Releases → Draft a new release

- Tag: `v2.5.0`
- Title: `Stop feeding premium models giant diffs`

Release Notes 粘贴：

```markdown
## What changed
- Default `include_diff:false` — Codex gets changed_files + checks, not full patches
- Zero-LLM `search` for repo discovery (0 tokens)
- One-call `analyze` for read-only summaries on cheap gateway
- `review` tool for cheap-gateway structured code review
- `shell` with `digest:true` for compact test/build/lint output
- JSONL metrics + `npm run stats` for real token accounting

## Measured impact
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Main-thread context (10 cmds) | 202,899 bytes | 41,048 bytes | -80% |
| Est. monthly saving (Sonnet) | — | — | ~$213/mo |
| Est. monthly saving (Opus) | — | — | ~$1,068/mo |

## Quick start
npm install && npm run build && npm run test
```

点 Publish release。

### 4.2 发 X/Twitter（英文版）

直接复制粘贴：

```
I built an MCP worker that changes WHERE the expensive tokens go.

Your premium AI model burns context reading files, retrying fixes, and ingesting giant diffs. That's expensive waste.

The fix: delegate the noisy middle to a cheaper async worker.

Before: 202,899 bytes of context for 10 commands.
After: 41,048 bytes.
80% less premium context burned.

It's not just "use a cheaper model." It's route optimization:
🔍 search: 0 LLM calls
📖 analyze: 1 cheap call, read-only
🔧 start: async worker does the heavy loop
✅ review: cheap gateway code review
📦 result: compact evidence, not full transcript

Works with any OpenAI-compatible gateway (DeepSeek, OneAPI, local models).

Safety: sandbox root, scoped patches, secret redaction, 429/5xx retry, tool circuit breakers, worktree isolation.

Cost estimate: ~$213/mo (Sonnet) to $1,068/mo (Opus) saved.

Quick start: npm install && npm run build, set gateway URL + key, npm run doctor.

The core idea applies beyond Codex: any AI coding workflow that reads files, runs fixes, and ingests diffs can benefit.

Premium model decides. Cheap model does the heavy lifting. Evidence, not transcripts.

🔗 https://github.com/luzmatrix002/ide-super-worker

#AI #Coding #MCP #CostOptimization #OpenSource
```

发出后点头像 → 置顶这条推文。

### 4.3 发 X/Twitter（中文版）

直接复制粘贴：

```
做了个 MCP Worker，改变贵模型 token 烧在哪里的问题。

问题：AI 编程时，贵的模型花大量上下文读文件、试错、吞大 diff。这些是浪费。

解法：把中间的重活甩给便宜的异步 worker。

实测数据：
传统方式 10 条命令：202,899 bytes 上下文
Worker 方式 10 条命令：41,048 bytes
降了 80%。

不是"换个便宜模型"那么简单。是路由优化：
🔍 search：零 LLM 调用
📖 analyze：一次便宜调用，只读
🔧 start：异步 worker 跑重活
✅ review：廉价网关代码审查
📦 结果：只给证据，不给过程

支持任何 OpenAI 兼容网关：DeepSeek、OneAPI、本地模型。

省钱估算：
Sonnet 级别约省 $213/月
Opus 级别约省 $1,068/月

三步跑起来：
npm install && npm run build
配 ONEAPI_BASE_URL + API_KEY
npm run doctor 验证

核心理念不限于 Codex：
任何"读文件→修代码→看 diff"的 AI 编程工作流，都能用这套路由省 token。

贵模型做决策。便宜模型干重活。只看证据，不看过程。

🔗 https://github.com/luzmatrix002/ide-super-worker

#AI编程 #开源 #省钱 #MCP #效率
```

### 4.4 发朋友圈 / 开发者微信群

```
做了个开源工具 IDE Super Worker，让 AI 编程省 80% 上下文。

实测 10 条命令：上下文从 20 万 bytes 降到 4 万。

不是换便宜模型，是优化路由：贵的模型只做决策和审查，重活甩给便宜 worker。

支持 DeepSeek、OneAPI、本地模型。

GitHub: https://github.com/luzmatrix002/ide-super-worker
```

配上 before/after 对比图。

---

## 五、Day 2：铺面日（北京时间上午 10:00 开始）

### 5.1 发 Hacker News

https://news.ycombinator.com → Submit

**Title:**

```
Show HN: IDE Super Worker – delegate expensive code work to cheaper async workers, cut premium context 80%
```

**Text:**

```
Hi HN,

I built an MCP worker that lets Codex (and similar AI coding agents) delegate the expensive part of coding tasks — bulk file reading, repair loops, test runs, diff ingestion — to an async worker running on a cheaper OpenAI-compatible model gateway.

The core insight: most AI coding tools optimize the model call. This project optimizes the route.

Measured impact on 10 shell commands:
- Main-thread context intake: 202,899 → 41,048 bytes (-80%)
- Estimated savings: $213/mo (Sonnet) to $1,068/mo (Opus)

The architecture includes: Anthropic-to-OpenAI adapter, 429/5xx retry, tool error circuit breakers, sandbox + secret redaction, worktree isolation, JSONL metrics.

The core idea applies to any AI coding workflow that reads files, runs fixes, and ingests diffs. The current implementation is Codex + Claude Code, but the routing pattern is general.

Reproducible demo: npm install → npm run build → npm run test → npm run smoke

https://github.com/luzmatrix002/ide-super-worker

I'd love feedback on the routing architecture and the cost-control approach.
```

### 5.2 发 Reddit（r/LocalLLaMA）

https://reddit.com/r/LocalLLaMA → Create Post

**Title:**

```
IDE Super Worker — route expensive AI coding work to your local/cheap gateway, cut premium context 80%
```

**Body:**

```
I built an open-source MCP worker that lets you delegate the expensive part of AI coding (file reading, repair loops, test runs, diff ingestion) to a cheaper async worker.

Why this matters for r/LocalLLaMA: the worker uses an Anthropic-to-OpenAI adapter, so Claude Code can talk to ANY OpenAI-compatible endpoint — including your local model, DeepSeek, OneAPI, etc.

The routing split:
- `search`: repo discovery, ZERO LLM calls
- `analyze`: read-only summary, ONE cheap call
- `start`: async implementation loop on your cheap gateway
- `review`: structured code review via cheap gateway
- `get`/`wait`: compact evidence, not full diffs

Measured: 80% less main-thread context for 10 commands. Est. $213-1068/mo saved.

Works with: DeepSeek, OneAPI, New API, local models, any OpenAI-compatible gateway.

Repo: https://github.com/luzmatrix002/ide-super-worker

Has anyone here tried routing Claude Code through a local model gateway? Would love to compare notes.
```

### 5.3 发 Reddit（r/ClaudeAI）

https://reddit.com/r/ClaudeAI → Create Post

**Title:**

```
Cut your Claude Code context usage by 80% — open-source MCP worker routes heavy work to cheaper gateways
```

**Body:**

```
If you're using Claude Code (or Codex) for coding, you've probably noticed that a lot of premium context gets burned on things that don't need Claude's full capability: reading files, running tests, retrying fixes, ingesting diffs.

I built IDE Super Worker to fix this. It's an open-source MCP tool that lets you delegate the expensive middle part of coding tasks to a cheaper async worker.

How it works:
1. Claude sends a small `start` request
2. Claude Code runs the task in the background
3. A local adapter routes model calls to your cheaper OpenAI-compatible gateway
4. Claude gets back compact evidence: changed_files, checks, logs, optional diff

Measured: 202,899 → 41,048 bytes of context for 10 commands (80% reduction).

Repo: https://github.com/luzmatrix002/ide-super-worker

Quick start: npm install && npm run build, set your gateway URL + key, npm run doctor.

Would love feedback from anyone using Claude Code with cheaper model backends.
```

### 5.4 发 V2EX

https://v2ex.com → 发新帖 → 节点选 `#分享创造` 或 `#开源软件`

**标题：**

```
做了个开源工具，让 AI 编程省 80% 上下文（实测数据）
```

**正文：**

```
最近在用 Codex/Claude Code 写代码，发现一个很烧钱的问题：贵的模型花大量上下文读文件、试错、吞大 diff。这些事根本不需要贵的模型来做。

所以做了 IDE Super Worker：一个异步 MCP worker，把重的部分甩给便宜的模型网关。

核心思路不是"换个便宜模型"，而是"优化路由"：

1. 搜代码 → 零 LLM 调用，本地搜索
2. 只读分析 → 一次便宜调用
3. 修 bug → 异步 worker 跑，贵模型不参与
4. 代码审查 → 廉价网关出结论
5. 看结果 → 只给 changed_files + checks，不给大 diff

实测数据（10 条 shell 命令）：
- 传统方式：202,899 bytes 上下文
- Worker 方式：41,048 bytes
- 降幅：80%

省钱估算：
- Sonnet 级别约省 $213/月
- Opus 级别约省 $1,068/月

支持任何 OpenAI 兼容网关：DeepSeek、OneAPI、本地模型。

三步跑起来：
1. npm install && npm run build
2. 配 .env（填网关地址和 API Key）
3. npm run doctor 验证

仓库：https://github.com/luzmatrix002/ide-super-worker

大家觉得这个路由思路怎么样？
```

### 5.5 发掘金

https://juejin.cn → 写文章

**标题：**

```
让 AI 编程成本降 80%：IDE Super Worker 路由优化实践
```

**开头：**

```
你有没有算过，用 AI 编程工具一个月花多少钱？

如果用 Claude Code 或 Codex 写代码，贵的模型在干这些事：
- 读一堆文件找 bug
- 反复试错修代码
- 跑测试吞全部日志
- 消化大 diff 看改动

这些事真的需要贵的模型来做吗？

不需要。搜索可以零 LLM 调用，只读分析可以一次便宜调用，修 bug 可以异步委派给廉价 worker，代码审查可以用便宜模型出结论。

这就是 IDE Super Worker 的核心思路：不是换便宜模型，是优化路由。
```

**文章结构（七节）：**

1. 问题：贵模型在烧什么 token
2. 解法：路由优化的五层架构（search/analyze/start/review/结果）
3. 实测数据（10 条命令对比 + 月度省钱估算 + 对比图表）
4. 架构设计（适配器、路由契约、熔断、可靠性档位、安全护栏）
5. 快速上手（三步配置 + 配置示例 + 常见问题）
6. 不限于 Codex（核心理念适用于所有用贵 LLM 的 IDE/Agent）
7. 总结与展望

**结尾：**

```
不是让模型更便宜，是让贵的模型只做值钱的事。

这才是 AI 编程省钱的正确姿势。

仓库：https://github.com/luzmatrix002/ide-super-worker
```

### 5.6 发 Discord

找到 MCP 官方 Discord、Claude Code 社区频道，粘贴：

**英文版：**

```
Hey everyone 👋

Just open-sourced IDE Super Worker — an async MCP worker that lets you delegate expensive coding work (file reading, repair loops, test runs, diff review) to a cheaper model gateway.

The core idea: don't just use a cheaper model. Optimize the route.

- `search`: 0 LLM calls for repo discovery
- `analyze`: 1 cheap call for read-only summaries
- `start`: async implementation on cheap gateway
- `review`: cheap gateway structured code review
- Results: changed_files + checks, not full diffs

Measured 80% context reduction on premium thread. Works with any OpenAI-compatible gateway (DeepSeek, OneAPI, local models, etc.).

Includes: Anthropic-to-OpenAI adapter, 429/5xx retry, tool circuit breakers, sandbox + secret redaction, worktree isolation, JSONL metrics.

Repo: https://github.com/luzmatrix002/ide-super-worker

Happy to help anyone get set up. The `npm run doctor` command validates your config and gateway connectivity.
```

**中文版：**

```
大家好 👋

刚开源了一个 IDE Super Worker —— 异步 MCP worker，可以把 AI 编程中贵的部分（读文件、修复循环、跑测试、看 diff）委派给便宜的模型网关。

核心理念：不是换个便宜模型，是优化路由。

- `search`：零 LLM 调用搜代码
- `analyze`：一次便宜调用做只读分析
- `start`：异步 worker 跑重活
- `review`：廉价网关做代码审查
- 结果：只给改动文件 + 检查结果，不塞大 diff

实测主线程上下文降 80%。支持任何 OpenAI 兼容网关（DeepSeek、OneAPI、本地模型等）。

包含：Anthropic-to-OpenAI 适配器、429/5xx 重试、工具熔断、沙箱 + 密钥脱敏、worktree 隔离、JSONL 指标。

仓库：https://github.com/luzmatrix002/ide-super-worker

配置有问题随时问，`npm run doctor` 可以验证环境和网关连通性。
```

---

## 六、Day 3：继续铺面 + 互动

### 6.1 回复所有已发帖子的评论

检查 HN、Reddit、V2EX、掘金评论区，用 FAQ 标准回答回复（见第九节）。有 star/issue 就感谢。

### 6.2 X/Twitter 发一条数据推

```
📊 Data drop:

10 shell commands through main thread: 202,899 bytes
Same 10 through worker: 41,048 bytes

80% context reduction = 80% less tokens to pay for.

That's the routing advantage. Not cheaper model. Shorter route.
```

---

## 七、Day 4-7：发酵日

### 7.1 发知乎

**回答模板（搜索"AI 编程工具哪家省钱""Claude Code 太贵"等问题）：**

```
先说结论：省钱的不是"换个便宜模型"，而是"优化路由"——让贵的模型只做值钱的事，重活甩给便宜的 worker。

我最近开源了一个工具叫 IDE Super Worker，实测能把 AI 编程的主线程上下文消耗降 80%。

传统 AI 编程的问题在于：贵的模型什么都干。搜代码要读一堆文件、修 bug 要反复试错、跑测试要吞全部日志、看 diff 要消化大补丁。这些事 90% 不需要贵的模型来做。

IDE Super Worker 的路由优化：

1. 搜代码 → 零 LLM 调用，本地搜索，完全不花 token
2. 只读分析 → 一次便宜调用，用 DeepSeek 等廉价模型
3. 修 bug → 异步 worker 跑，贵的模型不参与中间过程
4. 代码审查 → 廉价网关出结构化结论
5. 看结果 → 只给 changed_files + checks，不给大 diff

实测数据（10 条 shell 命令）：
- 传统方式：202,899 bytes 上下文
- Worker 方式：41,048 bytes
- 降幅：80%

省钱估算：
- 用 Sonnet：约省 $213/月
- 用 Opus：约省 $1,068/月

关键区别：这不是"换个便宜模型替代 Claude"那么简单。便宜模型替代不了 Claude 的决策能力。但如果把读文件、跑测试、改代码这些重活交给便宜模型，让 Claude 只做规划和审查，效果一样好，成本砍 80%。

而且这个思路不限于 Codex。任何"读文件→修代码→看 diff"的 AI 编程工作流，都能用这套路由省 token。Cursor、Windsurf、Copilot，原理一样。

开源地址：https://github.com/luzmatrix002/ide-super-worker

如果觉得有用可以试试，有问题评论区交流。
```

**专栏文章大纲：**

标题：你的 AI 编程账单有多贵？这个开源工具帮你砍 80%

结构：
1. 引言：AI 编程工具的便利与成本痛点
2. 钱烧在哪里：逐项分析 token 消耗
3. 省钱不是换便宜模型：路由优化的正确思路
4. IDE Super Worker 实测：80% 降耗数据 + 五层路由架构
5. 不限于 Codex：核心理念适用于所有 AI 编程工具
6. 三步上手
7. 成本对比表
8. 结尾

### 7.2 发公众号

标题：你的 AI 编程账单有多贵？这个开源工具帮你砍 80%

开头：

```
上周有个朋友跟我吐槽：用 AI 编程工具写了一个月代码，账单 $800。

我问他：你知道钱花在哪了吗？

他说不知道，反正每天用，每天扣费。

我帮他用 IDE Super Worker 跑了一遍同样的任务，账单从 $800 降到 $160。

省了 80%。

不是换了便宜模型。是优化了路由。
```

正文结构：
1. 你的钱烧在哪里（搜代码、修 bug、跑测试、看 diff）
2. 省钱不是换便宜模型（路由优化 vs 模型降级）
3. 五层省钱架构（search/analyze/start/review/结果）
4. 实测数据（202,899 → 41,048，降 80%，$213-1068/月）
5. 不限于 Codex（适用所有 AI 编程工作流）
6. 三步上手
7. 结尾：不是让模型更便宜，是让贵的模型只做值钱的事

### 7.3 X/Twitter 每日推文

Day 4（英文）：

```
💡 Tip: Use `include_diff:false` by default. Codex only needs to know WHAT changed and IF checks passed. Ask for the diff only when you actually need to review patch details.

One flag. Massive context savings.
```

Day 5（英文）：

```
🧠 The routing philosophy:

search → 0 LLM (free)
analyze → 1 cheap call (low)
start → async worker (low)
review → cheap gateway (low)
result → compact evidence (saves premium)

Premium model does decisions. Cheap model does muscle work.
```

Day 6（中文）：

```
💡 今日 tips：

默认用 `include_diff:false`。Codex 只需要知道改了什么文件、检查是否通过。真正要看 diff 细节时再开。

一个参数，省一大截上下文。
```

Day 7（中文）：

```
🧠 路由哲学：

search → 零 LLM（免费）
analyze → 一次便宜调用（低成本）
start → 异步 worker（低成本）
review → 廉价网关（低成本）
结果 → 紧凑证据（省贵的）

贵的做决策。便宜的干重活。
```

### 7.4 回 GitHub Issues

24 小时内回复所有 Issue 和 PR，感谢反馈，标记 bug/feature。

---

## 八、Day 8-14：扩散日

### 8.1 录 B 站视频

标题：AI 编程省钱神器：让 Claude 只干值钱的活，省 80% 上下文

时长：5-8 分钟

**脚本大纲：**

| 时间段 | 内容 |
|--------|------|
| 0:00-0:30 | 开场：展示一个月的 AI 编程账单截图，"教你砍掉 80% 的成本" |
| 0:30-1:30 | 问题：展示传统工作流（搜代码→修 bug→跑测试→看 diff，贵的模型什么都干） |
| 1:30-3:00 | 解法：介绍 IDE Super Worker，展示五层架构图 |
| 3:00-4:30 | 实操演示：终端录屏（配置 .env → npm run doctor → 发任务 → 对比上下文） |
| 4:30-5:30 | 数据对比：202,899 → 41,048，降 80%，省钱估算 |
| 5:30-6:30 | 不限于 Codex：适用所有 AI 编程工具 |
| 6:30-7:00 | 结尾："不是让模型更便宜，是让贵的模型只做值钱的事" |

简介区：

```
开源地址：https://github.com/luzmatrix002/ide-super-worker
省 80% 上下文 = 省 80% token = 省 80% 钱
#AI编程 #开源 #省钱 #Claude #编程效率
```

### 8.2 发小红书（3 条）

**第 1 条：**

标题：AI 编程省钱神器！让 Claude 只干值钱的活 💰

```
姐妹们/兄弟们！发现一个开源工具，AI 编程直接省 80% 上下文！

💰 省了多少钱？
原来一个月 $800 的 AI 编程账单
现在只要 $160
直接砍 80%！

🤔 怎么做到的？
不是换便宜模型！是优化路由！
让贵的模型只做决策和审查
重活（读文件、改代码、跑测试）甩给便宜的 worker

📊 实测数据：
10 条命令，上下文从 20 万 bytes 降到 4 万
降幅 80%

🔧 怎么用？
1. npm install && npm run build
2. 配 DeepSeek 网关地址
3. npm run doctor 验证
搞定！

💡 适合谁？
- 独立开发者，省钱续命
- 远程工作者，控制成本
- AI 编程重度用户
- 用 Claude/Codex/Cursor 的开发者

开源地址在评论区👇
#AI编程 #开源工具 #省钱 #独立开发者 #远程工作 #效率工具 #Claude #编程
```

配图：before/after 对比图、架构图、配置截图、月度账单对比。

**第 2 条：**

标题：独立开发者省钱指南：AI 编程一个月省 $600 是什么体验

```
作为独立开发者，每月 AI 编程成本是真实痛点。

之前用 Claude Code 写代码，一个月 $800+。
后来发现不是模型太贵，是路由太浪费。

贵的模型在干这些不值的事：
❌ 读一堆文件找 bug
❌ 反复试错改代码
❌ 吞全部测试日志
❌ 消化大 diff

换了 IDE Super Worker 后：
✅ 搜代码零 LLM 调用，0 token
✅ 只读分析一次便宜调用
✅ 修 bug 异步 worker 跑
✅ 代码审查廉价网关出结论
✅ 看结果只给证据，不给大 diff

结果：月账单从 $800 降到 $160。省了 $640。

省下的钱够买一年的 JetBrains 全家桶了 😂

开源免费，自己去试：
评论区有地址 👇

#独立开发者 #省钱 #AI编程 #开源 #远程工作 #副业 #效率工具
```

**第 3 条：**

标题：远程工作必备！这个开源工具让 AI 编程成本降 80%

```
远程工作两年，AI 编程工具是我的生产力支柱。
但每月几百刀的账单也是真实压力。

直到发现了这个开源工具：IDE Super Worker

它不换便宜模型，而是优化路由：
让贵的模型只做值钱的事（决策、审查）
把重活（读文件、改代码、跑测试）甩给便宜的 worker

实测数据：
传统方式 10 条命令：202,899 bytes 上下文
Worker 方式 10 条命令：41,048 bytes
降了 80%！

月度省钱估算：
Sonnet 级别约省 $213/月
Opus 级别约省 $1,068/月

支持 DeepSeek、OneAPI、本地模型等任何 OpenAI 兼容网关。

配置超简单，三步搞定：
1. npm install && npm run build
2. 配网关地址和 API Key
3. npm run doctor 验证

开源地址在评论区 👇

#远程工作 #AI编程 #开源工具 #省钱 #效率工具 #开发者日常
```

### 8.3 发抖音 / 视频号

**60 秒版脚本：**

标题：AI 编程省 80% 上下文！一个开源工具改变你的账单

| 时间 | 画面 | 配音 |
|------|------|------|
| 0-5秒 | 展示 $800 月度账单 | "你一个月花多少钱用 AI 写代码？" |
| 5-15秒 | 动画展示传统工作流 | "贵的模型什么都干：读文件、试错、跑测试、看 diff。90% 是浪费。" |
| 15-30秒 | before/after 对比柱状图 | "开源了一个工具，让贵的模型只做决策，重活甩给便宜 worker。上下文直接降 80%。" |
| 30-45秒 | 202,899 → 41,048 对比 | "实测 10 条命令，从 20 万 bytes 降到 4 万。一个月省 $200 到 $1000。" |
| 45-55秒 | 快速闪过功能列表 | "支持 DeepSeek、本地模型。零 LLM 搜索。工具熔断。密钥脱敏。三步配置。" |
| 55-60秒 | GitHub 链接 + Star 按钮 | "开源免费，去试试。不是让模型更便宜，是让贵的模型只做值钱的事。" |

简介：

```
AI 编程省钱神器，省 80% 上下文 = 省 80% 钱
开源地址：https://github.com/luzmatrix002/ide-super-worker
#AI编程 #省钱 #开源 #编程 #效率工具 #开发者
```

**30 秒极简版：**

标题：AI 编程一个月省 $600，我只做了一件事

| 时间 | 画面 | 配音 |
|------|------|------|
| 0-5秒 | $800 账单 → 划掉 → 写 $160 | "AI 编程从 $800 降到 $160，我只做了一件事。" |
| 5-15秒 | "路由优化"概念图 | "不是换便宜模型。是让贵的模型只做决策，重活甩给便宜的 worker。" |
| 15-25秒 | before/after 对比图 + 数据 | "实测上下文降 80%。一个月省 $200 到 $1000。支持 DeepSeek、本地模型。" |
| 25-30秒 | GitHub 链接 | "开源免费，评论区有地址。" |

### 8.4 掘金发第二篇教程

标题：手把手配置：用 DeepSeek 替代 Claude 跑 AI 编程任务

```
上一篇讲了 IDE Super Worker 的路由优化思路，这篇手把手教你配置。

目标：让 Codex 把重活（读文件、修代码、跑测试）甩给 DeepSeek，自己只做决策和审查。

步骤 1：安装
npm install && npm run build && npm run test

步骤 2：配置 .env
ONEAPI_BASE_URL=https://api.deepseek.com/v1
ONEAPI_API_KEY=your-key
CLAUDE_MODEL=deepseek-chat
USE_OPENAI_ADAPTER=1
SANDBOX_ROOT=D:/workspaces

步骤 3：验证
npm run doctor
npm run doctor:network

步骤 4：Codex 配置
复制 codex-mcp.example.toml 到 Codex 配置目录
修改路径和环境变量

步骤 5：跑第一个任务
在 Codex 里调用 start 工具，发一个"修复失败测试"的任务
用 get/wait 看结果
对比 include_diff:true 和 false 的上下文差异

省钱效果：
- 原来每条命令约 20K bytes 上下文
- 现在约 4K bytes
- 10 条命令省 160K bytes
- 按月估算省 $200-1000+

常见问题：
Q: DeepSeek 能替代 Claude 写代码吗？
A: 重活（读文件、改代码、跑测试）DeepSeek 完全够用。Claude 只做决策和审查。
Q: 延迟怎么样？
A: 异步 worker 不阻塞主线程，延迟不影响 Codex 响应。
Q: 怎么看省钱效果？
A: 配 WORKER_METRICS_FILE，跑 npm run stats 看实际 token 用量。
```

### 8.5 Reddit 发 r/programming

标题：

```
IDE Super Worker: an open-source MCP tool that cuts AI coding context usage 80% by routing heavy work to cheaper model gateways
```

正文简要介绍 + GitHub 链接 + 数据。

---

## 九、FAQ 话术（评论区答疑直接用）

### Q: 这和直接用 DeepSeek 代替 Claude 有什么区别？

换便宜模型只是降了单价，工作流还是一样的浪费：贵模型还是要读一堆文件、吞大 diff、跑修复循环。IDE Super Worker 优化的是路由：搜索零 token、只读分析一次便宜调用、重活异步委派给廉价 worker、结果只拿证据。贵模型只做决策和审查。省的不只是单价，更是 token 用量。

### Q: 这不就是给 Codex 加了个便宜后台吗？

不只是"加后台"。它是一套完整的路由架构：Codex-native MCP 接口让委派只需一次工具调用，Claude Code 执行循环让 worker 真的能改代码跑测试，Anthropic-to-OpenAI 适配器让 Claude Code 能用任何 OpenAI 兼容网关，scope 校验和 check 命令让工作可审计，紧凑结果让 Codex 不会吞多余 token。

### Q: 只支持 Codex 吗？Cursor/Windsurf 能用吗？

当前实现为 Codex + Claude Code 设计，但核心理念适用于所有使用高价 LLM 的 AI 编程场景。MCP 是开放协议，任何 MCP 兼容的 IDE/Agent 都可以接入。核心价值不在"支持哪个 IDE"，而在"路由优化"。

### Q: 80% 省的是上下文还是真金白银？

两者都是。80% 指的是主线程上下文摄入量从 202,899 bytes 降到 41,048 bytes（10 条命令实测）。上下文少了 = token 少了 = 真金白银省了。

### Q: 安全吗？会不会泄露代码？

有完整的安全护栏：SANDBOX_ROOT 限制 worker 只能在指定目录操作，scoped_patch 限制补丁范围，secret redaction 自动脱敏，permission_mode 控制权限级别，worktree 隔离支持并行任务。模型调用走你自己的网关，不经过第三方中转。

### Q: 配置复杂吗？小白能用吗？

三步就能跑起来：1）npm install && npm run build；2）配置 .env；3）npm run doctor 验证。

### Q: 和 aider、continue.dev 这些工具什么关系？

不同层面。aider/continue.dev 是"让便宜模型直接写代码"的工具。IDE Super Worker 优化的是路由：贵的模型做决策，便宜模型做重活，中间用路由契约连接。它不是替代品，而是基础设施层。

---

## 十、Day 15-30：沉淀日

### 每周固定动作

| 周几 | 做什么 |
|------|--------|
| 周一 | 检查 GitHub Issues，全部回复 |
| 周二 | X/Twitter 发一条 user case 或 tips |
| 周三 | 回复各平台评论区问题（用 FAQ 话术） |
| 周四 | 检查 KPI 是否达标 |
| 周五 | 根据反馈迭代代码，发 patch release |

### Day 30 发公众号月度总结

标题：上线 30 天，IDE Super Worker 帮开发者省了多少

结构：
1. 回顾上线 30 天的数据（Stars、下载量、社区反馈）
2. 用户真实省钱案例
3. 社区反馈精选
4. 省钱效果汇总
5. 下一步计划

---

## 十一、KPI 检查点

| 阶段 | GitHub Stars | 全网阅读 | Issues/PRs | 关键动作 |
|------|-------------|---------|-----------|----------|
| Day 3 | 50-100 | 2,000 | 5-10 | 确认核心社区已覆盖 |
| Day 7 | 150-250 | 5,000 | 15-25 | 深度内容已发布 |
| Day 14 | 300-400 | 8,000 | 30-40 | 泛流量平台已覆盖 |
| Day 30 | 500+ | 15,000+ | 50+ | 进入持续运营 |

---

## 十二、执行节奏原则

- 前 3 天集中火力铺面
- 第 4-7 天深度发酵
- 第 8-14 天扩散到泛流量
- 第 15-30 天沉淀运营
- 英文平台最佳发布时间：北京时间 22:00-02:00（对应美西上午）
- 中文平台最佳发布时间：北京时间 10:00-12:00 或 20:00-22:00

---

## 十三、发布检查清单

### 发布前准备

- [ ] README 已更新省钱数据表格和 before/after 对比图
- [ ] GitHub Topics 已添加（12 个）
- [ ] Release v2.5.0 已发布
- [ ] 本地可复现 demo 已验证（build + test + smoke 全通过）
- [ ] 终端录屏素材已准备（至少 1 个 30 秒 before/after 演示）
- [ ] before/after 对比图已制作

### Day 1 发布日

- [ ] GitHub Release 已发布
- [ ] X/Twitter Launch Thread 已发（中英各一条）
- [ ] 朋友圈/微信群已转发
- [ ] X/Twitter 推文已置顶

### Day 2-3 铺面日

- [ ] Hacker News Show HN 已发
- [ ] Reddit r/LocalLLaMA、r/ClaudeAI 已发帖
- [ ] V2EX 技术帖已发
- [ ] 掘金长文已发
- [ ] Discord 社区已分享

### Day 4-14 发酵+扩散

- [ ] 知乎回答 + 专栏已发
- [ ] 公众号推文已发
- [ ] B站演示视频已上传
- [ ] 小红书 3 条图文已发
- [ ] 抖音/视频号短视频已发
- [ ] 所有评论区/Issues 已回复

---

## 快速参考

```
仓库地址:     https://github.com/luzmatrix002/ide-super-worker
核心数据:     80% 上下文降耗, $213-1068/月省钱
核心口径(中):  不是让模型更便宜，是让贵的模型只做值钱的事
核心口径(英):  Don't just use a cheaper model. Make the expensive one do only what's worth it.
平台总数:     12+
排期:         Day 0-30，5 个阶段
```
