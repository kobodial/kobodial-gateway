type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * A minimal structured logger — JSON lines to stdout/stderr, nothing
 * more. Not pulling in a logging framework for what one small service
 * needs; the one property worth stating plainly is what this module
 * deliberately does NOT make easy: there is no helper here for logging
 * a request body, and there should never be one added.
 *
 * Africa's Talking's USSD callback body's `text` field accumulates
 * every keystroke of a session, `*`-joined — by the time a caller
 * reaches a PIN prompt, that field's last segment IS their raw PIN.
 * Any access-log middleware that logs `req.body` or the raw query
 * string wholesale would put a raw PIN into the log stream despite
 * every other layer of this codebase hashing on receipt. The house
 * rule: log method, path, status and duration for observability;
 * never log a request body, ever, for any route — see
 * src/routes/ussd.ts's request logger for what that looks like in
 * practice.
 */
class Logger {
  constructor(private readonly minLevel: Level) {}

  private log(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.log("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.log("error", message, fields);
  }
}

export function createLogger(level: Level): Logger {
  return new Logger(level);
}

export type { Logger };
