# 2.6.1：只读 Fan-out Coordinator

## 总结

- 应该并发，但禁止“每个 subagent 再启动多个 worker”的嵌套 fan-out。
- subagent 只负责把分析拆成 2–3 个独立关注点，然后调用一次 MCP；MCP 统一并发、限流、deadline、遥测和聚合。
- 首版只覆盖 `analyze/review`。禁止并发修改型 `start`：当前 worktree 创建失败会回退原工作树，不具备安全并发前提。
- 分支固定使用同一 `WORKER_LITE_MODEL`，并行完成后最多调用一次 `WORKER_SEMANTIC_REVIEW_MODEL` 做强审查。

## 接口与执行模型

扩展现有 `analyze/review`，旧请求行为完全不变：

```ts
interface FanoutBranchV1 {
  id: string;
  focus: string;
  max_tokens?: number;
}

interface FanoutOptionsV1 {
  branches?: FanoutBranchV1[]; // 2–3 个，省略则走原单调用
  aggregate?: "strong_review" | "none"; // 默认 strong_review
  deadline_ms?: number; // 默认 90s，上限 300s
}
```

- `analyze` 的 `prompt/files` 是共享任务和证据；每个分支只增加独立 `focus`。
- `review` 的 `job_id/files/focus` 是公共约束；分支 focus 分别检查规格、回归、边界等维度。
- 禁止协调器再自动调用 LLM 拆题，避免新增串行延迟；分支必须由 Codex/subagent 显式给出。
- 多分支响应使用 `fanout.v1`：

```ts
interface FanoutResultV1 {
  contract_version: "fanout.v1";
  fanout_id: string;
  kind: "analyze" | "review";
  status: "complete" | "partial" | "failed";
  reason_codes: string[];
  branches: Array<{
    id: string;
    status: "completed" | "failed" | "timed_out";
    preview?: string;
    artifact_ref?: string;
    duration_ms: number;
    reason_code?: string;
  }>;
  synthesis?: {
    model: string;
    verdict: "approve" | "needs_changes" | "risky" | "not_applicable";
    summary: string;
    findings: Array<{ severity: string; path?: string; line?: number; message: string }>;
    disagreements: string[];
    confidence: "low" | "medium" | "high";
    evidence_complete: boolean;
  };
  receipt: WorkerReceipt;
}
```

Fan-out 结果不复用 `OutcomeV1`，避免把只读 LLM 判断误称为确定性验收。

## 实现

- 新增进程内 `FanoutCoordinator` 和 FIFO semaphore：
  - `WORKER_FANOUT_ENABLED=0`，pilot 时显式开启。
  - `WORKER_FANOUT_MAX_BRANCHES=3`。
  - `WORKER_FANOUT_MAX_ACTIVE=1`。
  - `WORKER_LITE_MAX_CONCURRENCY=3`。
  - `WORKER_FANOUT_TIMEOUT_MS=90000`。
- semaphore 覆盖普通 `analyze/review`、failure digest、fan-out 分支、fan-out reviewer 和 semantic reviewer；不覆盖 Claude Code `start` 流量。
- 所有文件只读取一次，形成不可变 EvidencePack；各分支共享相同证据前缀。Fan-out 模式发现文件截断、超过 20 文件或 400KB 时直接拒绝，不发送不完整证据。
- 使用 `Promise.allSettled` 和共享 deadline：
  - 0 个成功：`failed`。
  - 1 个成功：`partial`，不调用 reviewer。
  - 至少 2 个成功：恰好调用一次 reviewer。
  - 任一分支失败或 reviewer 异常：`partial`。
  - 全部分支和 reviewer 成功：`complete`。
- reviewer 缺少模型配置时在分支执行前拒绝；primary 请求失败后不再切换第二模型。
- 完整分支输出写 artifact，主响应仅保留 1KB preview 和综合结论。
- metrics 增加 `fanout_id/branch_id/role/queue_wait_ms/e2e_ms/status`，分别记录分支、reviewer 和整体关键路径。
- Codex 路由规则限定：只有两个以上可独立验证、原本会串行执行的分析问题才能 fan-out；简单事实题、依赖链、测试等待和修改任务保持单路。

## 测试与验收

- 兼容性：未传 `branches` 的 `analyze/review` 与 2.6 输出完全一致。
- 并发：验证真实重叠执行、峰值不超过 3、同时最多一个 fan-out。
- 失败路径：分支 throw、429、timeout、部分成功、reviewer 缺失/超时/非法 JSON、总 deadline。
- 安全：重复 branch ID、超量分支、越界文件、截断 EvidencePack 均在模型调用前拒绝。
- 成本：相同 EvidencePack 只读取一次；cache key 包含任务、证据 hash 和 branch focus。
- CI 全部使用 mocked gateway，不产生付费调用。

上线前运行 30 个成对任务，对比“相同分支串行执行”与 fan-out：

- p50 端到端延迟降低 ≥30%。
- p95 延迟不得恶化超过 10%。
- 两臂 token/成本差异 ≤5%，确保只改变调度、不增加调用数量。
- 盲评不得新增 major/critical defect。
- reviewer 每题最多一次，嵌套 fan-out 为 0。
- 未达门槛时保持 `WORKER_FANOUT_ENABLED=0`，仅允许显式实验调用。

## 假设

- 已锁定优化对象为分析与 review，策略为稳健提速。
- 同一 cheap 模型负责分支多样化，差异来自关注点而非模型投票。
- 修改型并发留到 worktree 创建 fail-closed、事务合并和 deadline/cancel 完成后。
