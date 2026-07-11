import { receiptMetricExtra } from "./artifacts.js";

export type ToolMetricStatus = "ok" | "error" | "rejected";
export type ShellCommandStatus = "passed" | "failed" | "timeout";
export type ShellFailureKind =
  | "timeout"
  | "shell_mismatch"
  | "missing_command"
  | "test_failure"
  | "typecheck_failure"
  | "dependency_missing"
  | "permission_denied"
  | "unknown_failure";

export interface CanonicalFailure {
  kind: ShellFailureKind;
  retryable: true;
  route: "worker_local";
  action: string;
}

export interface ShellFailureProjection {
  failure_kind: ShellFailureKind;
  required_action: string;
  failure: CanonicalFailure;
  fallback: {
    retryable: true;
    action: string;
    alternatives: ["read_pack", "diff_digest", "shell"];
  };
}

export function assessShellFailure(
  command: string,
  status: ShellCommandStatus,
  output: string
): ShellFailureKind | undefined {
  if (status === "passed") return undefined;
  const combined = `${command}\n${output}`;
  if (status === "timeout" || /timed out|timeout/i.test(output)) return "timeout";
  if (
    /\b(Get-Content|ForEach-Object|Write-Output|Remove-Item|Set-Location|Select-String|Get-ChildItem)\b|\$[A-Za-z_][A-Za-z0-9_]*/.test(
      command
    )
  ) {
    return "shell_mismatch";
  }
  if (/AssertionError|ERR_ASSERTION|\bFAIL\b|tests? failed|failing tests?|failed tests?/i.test(output)) {
    return "test_failure";
  }
  if (/TS\d{4}:|TypeScript|\btsc\b/i.test(combined)) return "typecheck_failure";
  if (/Cannot find module|MODULE_NOT_FOUND|npm ERR! missing/i.test(output)) return "dependency_missing";
  if (/not recognized|command not found|executable file not found|ENOENT/i.test(output)) return "missing_command";
  if (
    process.platform === "win32" &&
    /^[A-Za-z0-9_.-]+$/.test(command.trim()) &&
    /[^\x00-\x7F]/.test(output)
  ) {
    return "missing_command";
  }
  if (/EACCES|EPERM|permission denied|access is denied/i.test(output)) return "permission_denied";
  return "unknown_failure";
}

export function shellFailureAction(kind: ShellFailureKind): string {
  switch (kind) {
    case "timeout":
      return "Split the command or increase timeout_ms only if the longer wait is intentional; inspect the artifact output before retrying.";
    case "shell_mismatch":
      return "Rewrite the command for the active shell, or wrap PowerShell syntax with powershell -NoProfile -Command before retrying.";
    case "missing_command":
      return "Verify the executable or package script exists in this workspace, then retry with the correct command.";
    case "test_failure":
      return "Fix the failing test or application code using the compact digest and artifact output, then rerun the smallest failing command.";
    case "typecheck_failure":
      return "Fix the reported TypeScript/import/schema errors, then rerun the same typecheck command.";
    case "dependency_missing":
      return "Verify dependencies and module names; run install only when dependency installation is intended for this workspace.";
    case "permission_denied":
      return "Adjust the command path or permissions inside the sandbox; do not bypass permissions unless explicitly intended.";
    default:
      return "Inspect the compact digest and artifact output, reduce to a focused repro, then retry the smallest corrective command.";
  }
}

export function buildShellFailureProjection(kind: ShellFailureKind): ShellFailureProjection {
  const failure: CanonicalFailure = {
    kind,
    retryable: true,
    route: "worker_local",
    action: shellFailureAction(kind)
  };
  return {
    failure_kind: failure.kind,
    required_action: failure.action,
    failure,
    fallback: {
      retryable: failure.retryable,
      action: failure.action,
      alternatives: ["read_pack", "diff_digest", "shell"]
    }
  };
}

export function shellToolDisposition(
  status: ShellCommandStatus,
  failureKind?: ShellFailureKind
): Exclude<ToolMetricStatus, "rejected"> {
  if (status === "passed") return "ok";
  return failureKind === "test_failure" || failureKind === "typecheck_failure" ? "ok" : "error";
}

function payloadObjectFromValue(value: unknown): Record<string, any> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  const content = (value as any)?.content;
  const text = Array.isArray(content) && typeof content[0]?.text === "string" ? content[0].text : undefined;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

export function classifyToolMetricPayload(
  value: unknown
): { status: ToolMetricStatus; extra: Record<string, unknown> } {
  const payload = payloadObjectFromValue(value);
  const receipt = payload?.receipt;
  if (!receipt) return { status: "ok", extra: {} };

  const outcome = payload?.outcome;
  const extra = {
    ...receiptMetricExtra(receipt),
    ...(typeof outcome?.status === "string" ? { outcome_status: outcome.status } : {}),
    ...(Array.isArray(outcome?.reason_codes) ? { outcome_reason_codes: outcome.reason_codes } : {}),
    ...(typeof outcome?.verification?.semantic === "string"
      ? { verification_semantic: outcome.verification.semantic }
      : {})
  };
  const payloadStatus = typeof payload.status === "string" ? payload.status : undefined;
  const jobStatus = typeof payload.job_status === "string" ? payload.job_status : payloadStatus;
  if (payloadStatus === "rejected") return { status: "rejected", extra };

  if (
    receipt.tool === "shell" &&
    receipt.category === "command_digest" &&
    (payloadStatus === "failed" || payloadStatus === "timeout")
  ) {
    const failureKind = (payload.failure?.kind ?? payload.failure_kind) as ShellFailureKind | undefined;
    return {
      status: shellToolDisposition(payloadStatus, failureKind),
      extra: {
        ...extra,
        command_status: payloadStatus,
        exit_code: payload.exit_code,
        failure_kind: failureKind,
        required_action: payload.failure?.action ?? payload.required_action,
        repair_route: "worker_local"
      }
    };
  }

  if (receipt.status === "error") {
    if (
      receipt.category === "job_control" &&
      ["running", "completed", "failed", "cancelled"].includes(String(jobStatus))
    ) {
      return {
        status: "ok",
        extra: {
          ...extra,
          job_status: jobStatus,
          repair_route: jobStatus === "failed" ? "worker_local" : undefined
        }
      };
    }
    return { status: "error", extra };
  }

  return { status: "ok", extra };
}
