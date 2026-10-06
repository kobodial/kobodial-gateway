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
/**
 * Stands in for an Africa's Talking API key that is not set. Named so it is
 * recognisable in a log line rather than looking like a real credential.
 */
export const PLACEHOLDER_API_KEY = "unset-no-outbound-messaging";

const envSchema = z.object({
  RPC_URL: z.string().url(),
  CONTRACT_ID: z.string().regex(/^C[A-Z2-7]{55}$/, "CONTRACT_ID must be a valid contract strkey (C...)"),
  NETWORK_PASSPHRASE: z.string().min(1),
  RELAYER_SECRET_KEY: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, "RELAYER_SECRET_KEY must be a valid secret strkey (S...)"),
  DATABASE_URL: z.string().min(1),
  /**
   * Secret key for deriving phone_hash and pin_hash. Required, with no
   * default: the contract publishes both digests to public storage, and
   * without this key they are enumerable (10,000 PINs; a national mobile
   * range for phone numbers). A default here would silently reinstate
   * exactly that. See src/crypto/hash.ts.
   */
  HASH_PEPPER: z.string().trim().min(64, "HASH_PEPPER must be at least 64 characters of high-entropy secret"),
  /**
   * Africa's Talking credentials.
   *
   * The USSD path never authenticates with them. The SDK client is built only
   * for its USSD() middleware, which parses the inbound callback body and
   * formats the plain-text reply — no outbound API call is made, so the key is
   * never checked against anything. The SDK does reject an empty string, which
   * is why there is a placeholder rather than nothing.
   *
   * Requiring a real key to boot therefore blocked deployment on a credential
   * the running service does not use. They become genuinely required when
   * outbound messaging exists (#9); until then the placeholder is honest about
   * what is configured, and the server warns when it is in use.
   */
  AFRICAS_TALKING_USERNAME: z.string().min(1).default("sandbox"),
  AFRICAS_TALKING_API_KEY: z.string().min(1).default(PLACEHOLDER_API_KEY),
  PORT: z
    .string()
    .default("3000")
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().positive().max(65535)),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /**
   * How many reverse proxies sit in front of this service. Needed to
   * identify the caller for rate limiting: unset, every visitor shares one
   * bucket; set too high, a caller can forge X-Forwarded-For and get a fresh
   * bucket per request. On Render the answer is 1.
   */
  TRUST_PROXY_HOPS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(0).max(10).optional()),
  /** Dashboard API requests allowed per minute, per caller. */
  RATE_LIMIT_MAX: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : Number.parseInt(v, 10)))
    .pipe(z.number().int().positive().max(100000).optional()),
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
