import { z } from "zod";

/**
 * Every environment variable the gateway needs, validated once at startup.
 *
 * Failing loudly and immediately on a missing or malformed variable is
 * deliberate: the alternative is a service that starts fine and only
 * discovers RELAYER_SECRET_KEY is malformed the first time a real USSD
 * session tries to send money, at which point the user is mid-session on
 * a feature phone with no way to see a stack trace.
 */
const envSchema = z.object({
  RPC_URL: z.string().url(),
  CONTRACT_ID: z
    .string()
    .regex(/^C[A-Z2-7]{55}$/, "CONTRACT_ID must be a valid contract strkey (C...)"),
  NETWORK_PASSPHRASE: z.string().min(1),
  RELAYER_SECRET_KEY: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, "RELAYER_SECRET_KEY must be a valid secret strkey (S...)"),
  DATABASE_URL: z.string().min(1),
  AFRICAS_TALKING_USERNAME: z.string().min(1),
  AFRICAS_TALKING_API_KEY: z.string().min(1),
  PORT: z
    .string()
    .default("3000")
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().positive().max(65535)),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates process.env. Call once at startup; the result is
 * meant to be threaded through the app, not re-read from process.env
 * elsewhere, so every consumer sees the same validated shape.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
