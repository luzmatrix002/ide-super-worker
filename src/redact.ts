const SECRET_NAMES = [
  "ONEAPI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "FALLBACK_API_KEY"
] as const;

function literalReplaceAll(value: string, needle: string, replacement: string): string {
  return needle ? value.split(needle).join(replacement) : value;
}

export function redactSecrets(input: unknown): string {
  let text = typeof input === "string" ? input : JSON.stringify(input);
  if (!text) return "";

  for (const name of SECRET_NAMES) {
    const secret = process.env[name];
    if (secret && secret.length >= 4) {
      text = literalReplaceAll(text, secret, "[redacted]");
    }
  }

  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]");
  return text;
}
