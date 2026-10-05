import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

/**
 * Rate limiting for the dashboard API.
 *
 * The dashboard routes are unauthenticated, and `GET /wallets/:phoneHash/balance`
 * reaches the contract over RPC on every call. Unthrottled, a caller can drive
 * unbounded RPC traffic through the gateway — which costs the operator and can
 * exhaust the provider's own rate limit, degrading the USSD path. That is the
 * part that matters: a dashboard being slow is an inconvenience, a USSD session
 * failing is someone unable to reach their money.
 *
 * ## What is deliberately not limited
 *
 * The USSD callback. Africa's Talking posts every interaction from their own
 * infrastructure, so all real traffic arrives from a small set of addresses
 * and would share one bucket. Throttling that would drop legitimate sessions
 * at busy moments — turning a protection into the outage it exists to prevent.
 *
 * ## On identifying the caller
 *
 * Behind a proxy, the peer address is the proxy, so every visitor shares a
 * bucket unless Express is told how many hops to trust. `X-Forwarded-For` is
 * caller-controlled and can be forged, so trusting it is only sound as far as
 * the proxy in front rewrites it — which is why the hop count is configured
 * explicitly rather than enabled blindly. See `TRUST_PROXY_HOPS` in
 * .env.example.
 */

/** Requests allowed per window, per caller. */
export const DEFAULT_MAX_REQUESTS = 120;

/** Window length. 120 requests a minute is far above a human reading pages. */
export const WINDOW_MS = 60_000;

export interface RateLimitOptions {
  max?: number;
  windowMs?: number;
}

export function dashboardRateLimit(options: RateLimitOptions = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? WINDOW_MS,
    limit: options.max ?? DEFAULT_MAX_REQUESTS,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // The error envelope the rest of this API uses, so a client parses one
    // shape rather than special-casing 429.
    message: { error: "Too many requests. Please slow down and try again shortly." },
    // Health checks come from the hosting platform on a fixed schedule and
    // must never be throttled: a 429 there reads as the service being down
    // and gets the instance restarted.
    skip: (req) => req.path === "/health",
  });
}
