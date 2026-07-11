import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assessAbnormalReceipt } from "./abnormal_output.js";
import { SANDBOX_ROOT } from "./config.js";
import { redactSecrets } from "./redact.js";
import type { WorkerReceipt } from "./types.js";

const ARTIFACT_REF_PREFIX = "artifact://";
const ARTIFACT_SLICE_MAX_BYTES = 64_000;

interface ArtifactRecord {
  file: string;
  bytes: number;
  kind: string;
}

const artifacts = new Map<string, ArtifactRecord>();

function byteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function artifactDir(): string {
  const sandboxHash = crypto.createHash("sha256").update(path.resolve(SANDBOX_ROOT)).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "ide-super-worker-artifacts", sandboxHash, String(process.pid));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveArtifact(kind: string, content: unknown): { artifact_ref: string; bytes: number } | undefined {
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const safe = redactSecrets(text || "");
  if (!safe) return undefined;
  try {
    const id = crypto.randomUUID();
    const ref = `${ARTIFACT_REF_PREFIX}${id}`;
    const file = path.join(artifactDir(), `${id}.txt`);
    fs.writeFileSync(file, safe, "utf8");
    const bytes = Buffer.byteLength(safe, "utf8");
    artifacts.set(ref, { file, bytes, kind });
    return { artifact_ref: ref, bytes };
  } catch {
    // Artifact persistence is best-effort. If the file system is unavailable
    // (disk full, permission denied, etc.), return undefined so the caller
    // continues without an artifact_ref rather than failing the entire tool
    // call.  The receipt will still record output_bytes, allowing downstream
    // audits to detect the missing artifact.
    return undefined;
  }
}

export function createReceipt(args: {
  tool: string;
  category: string;
  input?: unknown;
  output?: unknown;
  summary?: unknown;
  artifactRefs?: string[];
  truncated?: boolean;
  cached?: boolean;
  status?: "ok" | "error";
}): WorkerReceipt {
  const receipt = {
    route: "worker",
    tool: args.tool,
    category: args.category,
    input_bytes: byteLength(args.input),
    output_bytes: byteLength(args.output),
    summary_bytes: byteLength(args.summary ?? args.output),
    artifact_refs: [...new Set(args.artifactRefs || [])],
    truncated: args.truncated === true,
    cached: args.cached === true,
    status: args.status || "ok"
  };
  return {
    ...receipt,
    abnormal: assessAbnormalReceipt(receipt)
  };
}

export function attachReceipt<T extends Record<string, unknown>>(
  value: T,
  receiptArgs: Parameters<typeof createReceipt>[0]
): T & { receipt: WorkerReceipt } {
  const summary = { ...value } as Record<string, unknown>;
  delete summary.receipt;
  return {
    ...value,
    receipt: createReceipt({ ...receiptArgs, summary })
  };
}

export function receiptMetricExtra(receipt: WorkerReceipt | undefined): Record<string, unknown> {
  return receipt ? { receipt } : {};
}

export function getArtifactSlice(args: Record<string, unknown>): Record<string, unknown> {
  const artifactRef = typeof args.artifact_ref === "string" ? args.artifact_ref : "";
  if (!/^artifact:\/\/[0-9a-f-]{36}$/i.test(artifactRef)) {
    throw new Error("invalid artifact_ref");
  }
  const record = artifacts.get(artifactRef);
  if (!record) throw new Error("artifact_ref not found");

  const offset = Math.max(0, Math.trunc(Number(args.offset ?? 0)));
  const limit = Math.min(ARTIFACT_SLICE_MAX_BYTES, Math.max(1, Math.trunc(Number(args.limit ?? 16_000))));
  const buffer = fs.readFileSync(record.file);
  const slice = buffer.subarray(offset, Math.min(buffer.length, offset + limit)).toString("utf8");
  const text = redactSecrets(slice);
  return attachReceipt(
    {
      artifact_ref: artifactRef,
      kind: record.kind,
      offset,
      limit,
      total_bytes: record.bytes,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: offset + limit < buffer.length,
      text
    },
    {
      tool: "get_artifact_slice",
      category: "artifact",
      input: args,
      output: { artifact_ref: artifactRef, offset, limit, total_bytes: record.bytes },
      artifactRefs: [artifactRef],
      truncated: offset + limit < buffer.length
    }
  );
}
