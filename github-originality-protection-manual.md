# IDE Super Worker GitHub 原创性防护执行手册

> 本手册涵盖代码层面已完成的所有修复 + GitHub 网页端待执行操作。
> 按顺序逐项执行即可。

---

## 一、代码层面已完成（无需操作）

以下修复已在本工作区完成，确认无误后 git commit + push 即可生效：

| # | 文件 | 状态 | 说明 |
|---|------|------|------|
| 1 | `LICENSE` | ✅ 已修复 | 版权人从 "contributors" 改为 "luzmatrix002" |
| 2 | `README.md` | ✅ 已修复 | 末尾新增 Attribution 部分 + License 部分 |
| 3 | `package.json` | ✅ 已修复 | 补全 author/repository/bugs/homepage/license |
| 4 | `CONTRIBUTING.md` | ✅ 已修复 | 新增 Originality Policy 章节 |
| 5 | `RELEASE_CHECKLIST.md` | ✅ 已修复 | 新增 7 项原创性检查项 |
| 6 | `CODE_OF_CONDUCT.md` | ✅ 新建 | 社区行为准则，禁止抄袭 |
| 7 | `.github/CODEOWNERS` | ✅ 新建 | PR 自动指派 luzmatrix002 审查 |
| 8 | `.github/PULL_REQUEST_TEMPLATE.md` | ✅ 新建 | 含原创性声明勾选项 |
| 9 | `.github/ISSUE_TEMPLATE/bug_report.md` | ✅ 新建 | Bug 报告模板 |
| 10 | `.github/ISSUE_TEMPLATE/feature_request.md` | ✅ 新建 | 功能请求模板 |
| 11 | `.github/ISSUE_TEMPLATE/plagiarism_report.md` | ✅ 新建 | 抄袭举报模板 |
| 12 | `.github/workflows/ci.yml` | ✅ 新建 | CI 工作流（Node 20/22 矩阵） |

---

## 二、本地提交（在终端执行）

```powershell
cd 'd:\知识库\_Areas（长期领域）\ide-super-worker-rewrite'

# 查看改动
git status

# 暂存所有改动
git add -A

# 提交
git commit -m "chore: strengthen GitHub originality protection

- Fix LICENSE copyright holder to specific author
- Add README Attribution section crediting external sources
- Add CODE_OF_CONDUCT.md
- Add Issue templates (bug, feature, plagiarism report)
- Add PR template with originality declaration
- Add CODEOWNERS for auto-review assignment
- Add CI workflow (Node 20/22 matrix)
- Update CONTRIBUTING.md with Originality Policy
- Update RELEASE_CHECKLIST.md with originality checks
- Update package.json with repository metadata"

# 推送
git push origin main
```

---

## 三、GitHub 网页端配置（手动操作）

### 步骤 1：设置仓库基本信息

1. 打开 https://github.com/luzmatrix002/ide-super-worker
2. 点右上角齿轮（About 旁边）
3. 填写 Description：
   ```
   Cost-saving async MCP worker: delegate expensive code work to cheaper model gateways, cut premium context 80%.
   ```
4. 填写 Topics（逐个输入后回车）：
   ```
   mcp
   codex
   claude-code
   ai-coding
   openai-compatible
   developer-tools
   cost-optimization
   typescript
   async-worker
   context-optimization
   llm-gateway
   deepseek
   ```
5. 点 Save changes

### 步骤 2：开启分支保护

1. 进入 Settings → Branches
2. 点 Add branch protection rule
3. Branch name pattern 填：`main`
4. 勾选以下选项：
   - ☑ Require status checks to pass before merging
     - 搜索并勾选 `build-and-test` （CI 工作流名称）
   - ☑ Require branches to be up to date before merging
   - ☑ Require conversation resolution before merging
   - ☑ Do not allow bypassing the above settings
5. 点 Create

### 步骤 3：配置 PR 设置

1. 进入 Settings → General
2. 滚动到 Pull Requests 部分
3. 勾选：
   - ☑ Allow squash merging（默认）
   - ☑ Automatically delete head branches
4. 点 Save changes

### 步骤 4：确认 Issues 功能已开启

1. 进入 Settings → General
2. 滚动到 Features 部分
3. 确认勾选：
   - ☑ Issues
   - ☑ Discussions（可选，用于社区交流）
4. 点 Save changes

### 步骤 5：添加 GitHub Security Policy 链接

1. 进入 Settings → Security → Security advisories
2. 确认 "Private security advisories" 已开启（通常默认开启）

---

## 四、原创性防护验证清单

提交并配置完成后，逐项确认：

### 代码文件验证

- [ ] 打开 https://github.com/luzmatrix002/ide-super-worker/blob/main/LICENSE — 确认第 3 行是 `Copyright (c) 2026 luzmatrix002`
- [ ] 打开 README.md — 确认末尾有 `## Attribution` 部分
- [ ] 打开 CONTRIBUTING.md — 确认有 `## Originality Policy` 部分
- [ ] 打开 CODE_OF_CONDUCT.md — 确认存在且内容完整
- [ ] 打开 .github/CODEOWNERS — 确认内容为 `* @luzmatrix002`
- [ ] 打开 .github/PULL_REQUEST_TEMPLATE.md — 确认有 `## Originality Declaration` 勾选项

### GitHub 功能验证

- [ ] 仓库首页 About 区域显示 Description 和 12 个 Topics
- [ ] Settings → Branches 显示 main 分支保护规则
- [ ] 点 New Pull Request 时能看到 PR 模板
- [ ] 点 New Issue 时能看到 3 个模板选项（Bug/Feature/Plagiarism）
- [ ] Actions 页面显示 CI 工作流（push 或 PR 后自动触发）

### 原创性验证

- [ ] `src/reasoning.ts` 开头注释已标注 Mythos 架构和 Geiping et al. 2025 来源
- [ ] `cheap_worker_evaluation_report.md` 已标注 `tomicz/fable-5` 方法论来源
- [ ] LICENSE 版权人指向具体 GitHub 用户（luzmatrix002）
- [ ] package.json 的 author 字段为 "luzmatrix002"
- [ ] 所有新增文件均为原创，无从其他项目复制的代码

---

## 五、定期维护建议

| 频率 | 动作 |
|------|------|
| 每月 | 检查 GitHub 是否有 fork 未标注来源，用 plagiarism_report 模板举报 |
| 每月 | 检查 Dependabot 告警，更新依赖 |
| 每次 PR | 确认 PR 模板中 Originality Declaration 已勾选 |
| 每次发版 | 对照 RELEASE_CHECKLIST.md 逐项检查 |
| 每季度 | 审查 CODEOWNERS，确认审查人列表是最新的 |

---

## 六、快速参考

```
仓库地址:  https://github.com/luzmatrix002/ide-super-worker
License:   MIT
版权人:    luzmatrix002
CI 工作流:  .github/workflows/ci.yml
分支保护:   main (require status checks)
Issue 模板:  .github/ISSUE_TEMPLATE/
PR 模板:    .github/PULL_REQUEST_TEMPLATE.md
代码所有权:  .github/CODEOWNERS
```
