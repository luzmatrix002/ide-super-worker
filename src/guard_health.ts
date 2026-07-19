export type GuardHealthState = "HEALTHY" | "QUIET" | "RECOVERING" | "DEGRADED" | "TELEMETRY_FAULT" | "UNAVAILABLE";

export interface GuardBreachV1 {
  key: string;
  scope: "overall" | "category" | "tool" | "fallback";
  calls: number;
  errors: number;
  rate_pct: number;
  threshold_pct: number;
}

export interface GuardWindowV1 {
  minutes: 60 | 1440 | 10080;
  calls: number;
  errors: number;
  breaches: GuardBreachV1[];
  complete: boolean;
}

export interface GuardEvaluationInputV1 {
  windows: { one_hour: GuardWindowV1; one_day: GuardWindowV1; seven_days: GuardWindowV1 };
  eligible_total: number;
  worker_selected: number;
  worker_metric_count: number;
  missing_post_count: number;
  canary_ok: boolean;
  canary_error?: string;
}

export interface GuardStateMemoryV1 {
  state: GuardHealthState;
  consecutive_key?: string;
  consecutive_count: number;
  consecutive_healthy: number;
}

export interface GuardEvaluationV1 extends GuardStateMemoryV1 {
  reason: string;
  alert: boolean;
  alert_level?: "Information" | "Warning" | "Error";
}

const emptyMemory: GuardStateMemoryV1 = {
  state: "HEALTHY",
  consecutive_count: 0,
  consecutive_healthy: 0
};

function sustainedBreachKey(input: GuardEvaluationInputV1): string | undefined {
  const dayKeys = new Set(input.windows.one_day.breaches.map((breach) => breach.key));
  return input.windows.one_hour.breaches.map((breach) => breach.key).sort().find((key) => dayKeys.has(key));
}

function nextCount(previous: GuardStateMemoryV1, key: string): number {
  return previous.consecutive_key === key ? previous.consecutive_count + 1 : 1;
}

export function evaluateGuardHealth(
  input: GuardEvaluationInputV1,
  previous: GuardStateMemoryV1 = emptyMemory
): GuardEvaluationV1 {
  if (!input.canary_ok) {
    return {
      state: "UNAVAILABLE",
      consecutive_key: "canary",
      consecutive_count: nextCount(previous, "canary"),
      consecutive_healthy: 0,
      reason: input.canary_error || "worker canary failed after retry",
      alert: previous.state !== "UNAVAILABLE",
      alert_level: "Error"
    };
  }

  const telemetryFault = input.worker_selected > 0 && (input.worker_metric_count === 0 || input.missing_post_count > 0);
  if (telemetryFault) {
    const count = nextCount(previous, "telemetry");
    const active = count >= 2;
    return {
      state: active ? "TELEMETRY_FAULT" : "RECOVERING",
      consecutive_key: "telemetry",
      consecutive_count: count,
      consecutive_healthy: 0,
      reason: "worker-selected routing opportunities are not matched by complete worker telemetry",
      alert: active && previous.state !== "TELEMETRY_FAULT",
      ...(active ? { alert_level: "Warning" as const } : {})
    };
  }

  const breachKey = sustainedBreachKey(input);
  if (breachKey) {
    const count = nextCount(previous, `breach:${breachKey}`);
    const active = count >= 2;
    return {
      state: active ? "DEGRADED" : "RECOVERING",
      consecutive_key: `breach:${breachKey}`,
      consecutive_count: count,
      consecutive_healthy: 0,
      reason: `same SLO scope breached in 1h and 24h: ${breachKey}`,
      alert: active && previous.state !== "DEGRADED",
      ...(active ? { alert_level: "Warning" as const } : {})
    };
  }

  if (input.eligible_total === 0) {
    return {
      state: "QUIET",
      consecutive_count: 0,
      consecutive_healthy: previous.consecutive_healthy + 1,
      reason: "no hook-observable eligible demand and canary passed",
      alert: false
    };
  }

  const hasSevenDayDebt = input.windows.seven_days.breaches.length > 0;
  const recoveringFromAlert = ["DEGRADED", "TELEMETRY_FAULT", "UNAVAILABLE"].includes(previous.state);
  const healthyCount = previous.consecutive_healthy + 1;
  if (hasSevenDayDebt || (recoveringFromAlert && healthyCount < 2)) {
    return {
      state: "RECOVERING",
      consecutive_count: 0,
      consecutive_healthy: healthyCount,
      reason: hasSevenDayDebt ? "1h/24h healthy while 7d retains error-budget debt" : "awaiting second healthy watch run",
      alert: false
    };
  }

  const recovered = recoveringFromAlert || previous.state === "RECOVERING";
  return {
    state: "HEALTHY",
    consecutive_count: 0,
    consecutive_healthy: healthyCount,
    reason: "canary, telemetry, and sustained SLO checks passed",
    alert: recovered,
    ...(recovered ? { alert_level: "Information" as const } : {})
  };
}
