// What every cron function's config shares. A leaf module: it imports no schema, so a config that
// takes these constants does not bundle the delivery or Resend parsers with them.

/** The .env.example value for CRON_SECRET (Vercel's cron requests carry `Authorization: Bearer <CRON_SECRET>`). */
export const PLACEHOLDER_CRON_SECRET = "replace-with-a-cron-secret-of-32-or-more-chars";
/** The longest run budget a cron function accepts: Vercel stops a function at 30 s (build-vercel.mjs `maxDuration`). */
export const DELIVERY_CRON_BUDGET_LIMIT_MS = 20_000;
