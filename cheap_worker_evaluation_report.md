# ide-super-worker Cheap Worker Reliability & Upgrade Evaluation Report

## 1. Executive Summary

This report evaluates the feasibility, alignment, and implementation strategy of the proposed **Cheap Worker Reliability Upgrade Blueprint** (based on `cheap worker update.md` and the `tomicz/fable-5` methodology) within the existing **ide-super-worker-rewrite** codebase.

### Key Finding
**Highly Feasible and Structurally Aligned.**
The current codebase already implements a deterministic, Mythos-style reasoning and quality-control layer (`src/reasoning.ts`), an automatic revise/retry loop (`MYTHOS_AUTO_REVISE` in `src/config.ts`), sandboxed file/glob checks (`src/lite.ts`, `src/checks.ts`), and a structured abnormal output assessment system (`AbnormalOutputAssessment` in `src/types.ts`).

Upgrading this system from simple deterministic metrics to a structured **Skill Library + Execution Exoskeleton + Trajectory Evaluation + Reliability Tiering** is the logical next step. It directly addresses "cheap worker cognitive decline" without incurring the cost of high-tier models.

---

## 2. Gap Analysis & Codebase Alignment

| Proposed Component in `cheap worker update.md` | Existing Codebase State | Gap / Extension Required | Feasibility |
| :--- | :--- | :--- | :--- |
| **1. Worker Reliability Skills** (`.claude/skills/` or equivalent custom runbooks) | The workspace operates purely on programmatic scripts and config flags. No structured "skill library" or downstream runbooks exist. | Establish a dedicated project-specific skill directory (e.g., `.worker/skills/` or `src/skills/`) containing machine-parsable runbooks for tasks like `worker-debugging-playbook`, `worker-failure-archaeology`, etc. | **High** |
| **2. Reliability Tiers** (`lite`, `standard`, `strict`, `critical`) | `src/lite.ts` implements a read-only path (no editing, zero-hop). Standard editing is supported. | Explicitly formalize and enforce these 4 tiers in `src/types.ts` (`JobState`) and restrict tools based on the active tier. | **High** |
| **3. Skill Distillation Pipeline** (Phase 1-4) | No automated system for distilling experiences into reusable skills exists. | Create a script under `scripts/distill_skills.ts` utilizing the strong model (e.g., `sonnet`) to analyze failed worker episodes and write structured markdown runbooks. | **Medium** |
| **4. Episode Package & Eval Harness** | `JobResult` tracks file changes, checks, cost, and reasoning reports, but doesn't output a replayable "Episode Package." | Extend `src/types.ts` and `src/metrics.ts` to output a standardized JSON/YAML replay archive containing inputs, exact tool trajectory, artifacts, and a trajectory score. | **High** |
| **5. Tool Firewall & Dynamic Tool Router** | Current tools are exposed wholesale via MCP. There is some security path validation. | Implement a dynamic middleware or router inside `src/worker_tools.ts` that filters visible tools based on the active Reliability Tier. | **High** |
| **6. Compound Tools** (`inspect_failure`, `make_scoped_patch`) | Core functions are separate (`src/checks.ts`, `src/reasoning.ts`). | Package these sequential actions into high-level MCP tools to prevent cheap models from misusing low-level tools in loops. | **High** |

---

## 3. Implementation Roadmap & Architecture Design

### Phase 1: Establish Reliability Tiers & Dynamic Tool Firewall
Modify `src/types.ts` to support explicit execution tiers:
```typescript
export type ReliabilityTier = 'lite' | 'standard' | 'strict' | 'critical';

export interface JobState {
  // ... existing fields
  tier: ReliabilityTier;
}
```
Enforce tool restrictions in the tool router:
- **Lite**: Only allow `search`, `read_sandboxed_file`, and cached reads. Direct editing is blocked.
- **Standard**: Allow `scoped_patch` + auto-checks + reasoning gate.
- **Strict**: Enforce git worktree isolation, strict trajectory validation, and a semantic reviewer pass.
- **Critical**: Escalate directly to the strong model or require interactive approval.

### Phase 2: Create the Skill Library & Exoskeleton
1. **Define the Skill Form
