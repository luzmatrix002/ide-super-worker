import assert from "node:assert/strict";
import { evaluateGuardHealth, type GuardEvaluationInputV1, type GuardWindowV1 } from "../guard_health.js";

const window = (minutes: 60 | 1440 | 10080, breaches: GuardWindowV1["breaches"] = []): GuardWindowV1 => ({
  minutes, calls: 100, errors: 0, breaches, complete: true
});
const breach = { key: "tool:shell", scope: "tool" as const, calls: 29, errors: 1, rate_pct: 3.45, threshold_pct: 3 };
const base = (overrides: Partial<GuardEvaluationInputV1> = {}): GuardEvaluationInputV1 => ({
  windows: { one_hour: window(60), one_day: window(1440), seven_days: window(10080) },
  eligible_total: 10, worker_selected: 8, worker_metric_count: 8, missing_post_count: 0, canary_ok: true, ...overrides
});

assert.equal(evaluateGuardHealth(base({ eligible_total: 0, worker_selected: 0, worker_metric_count: 0 })).state, "QUIET");
assert.equal(evaluateGuardHealth(base({ canary_ok: false, canary_error: "spawn failed" })).state, "UNAVAILABLE");

const firstTelemetry = evaluateGuardHealth(base({ worker_metric_count: 0 }));
assert.equal(firstTelemetry.state, "RECOVERING");
const secondTelemetry = evaluateGuardHealth(base({ worker_metric_count: 0 }), firstTelemetry);
assert.equal(secondTelemetry.state, "TELEMETRY_FAULT");
assert.equal(secondTelemetry.alert, true);

const sustained = base({ windows: { one_hour: window(60, [breach]), one_day: window(1440, [breach]), seven_days: window(10080, [breach]) } });
const firstBreach = evaluateGuardHealth(sustained);
assert.equal(firstBreach.state, "RECOVERING");
const secondBreach = evaluateGuardHealth(sustained, firstBreach);
assert.equal(secondBreach.state, "DEGRADED");
assert.equal(secondBreach.alert, true);

const sevenDayOnly = evaluateGuardHealth(base({ windows: { one_hour: window(60), one_day: window(1440), seven_days: window(10080, [breach]) } }));
assert.equal(sevenDayOnly.state, "RECOVERING");
assert.equal(sevenDayOnly.alert, false);

const firstHealthy = evaluateGuardHealth(base(), secondBreach);
assert.equal(firstHealthy.state, "RECOVERING");
const secondHealthy = evaluateGuardHealth(base(), firstHealthy);
assert.equal(secondHealthy.state, "HEALTHY");
assert.equal(secondHealthy.alert_level, "Information");

console.log("guard health tests passed");
