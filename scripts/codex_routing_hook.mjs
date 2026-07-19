#!/usr/bin/env node
import { appendRoutingObservation, routingObservationFromHook } from "../dist/routing_observation.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk.toString("utf8");
try {
  const input = raw.trim() ? JSON.parse(raw) : {};
  appendRoutingObservation(routingObservationFromHook(input));
} catch (error) {
  process.stderr.write(`[routing-hook] observation skipped: ${error instanceof Error ? error.message : String(error)}\n`);
}
