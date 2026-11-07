// The one list of variable names only the workers Vercel project (or a Mac worker) may hold. The API
// project sets none of them, so none may appear in the API function's bundle. test/worker-split.test.ts
// checks the bundle against this list and the README env table against it. Variables both projects
// read (DATABASE_CA_CERT, UNSUBSCRIBE_TOKEN_SECRET, ACTIVEPIECES_KEY_SECRET, GOOGLE_CLIENT_*,
// GOOGLE_*_BASE_URL, GOOGLE_CHANNEL_SECRET, PUBLIC_BOOKING_KEY_SECRET, PUBLIC_BASE_URL,
// TWILIO_ACCOUNT_SID, TWILIO_WEBHOOK_BASE_URL) are not here.

/** The five cron schedules, set as build variables on the workers project only. */
export const CRON_SCHEDULE_VARIABLES = [
  "DELIVERY_CRON_SCHEDULE", "BILLING_CRON_SCHEDULE", "CALENDAR_CRON_SCHEDULE", "ACTIVEPIECES_CRON_SCHEDULE", "FOLLOWUP_CRON_SCHEDULE",
];

export const WORKER_ONLY_ENV = [
  // Vercel Cron's bearer; every cron route checks it
  "CRON_SECRET",
  // delivery (src/delivery/config.ts, @zs/core resend.ts and twilio.ts)
  "DELIVERY_WORKER", "DELIVERY_WORKER_ID", "DELIVERY_DATABASE_URL", "DELIVERY_PRICE_EMAIL", "DELIVERY_PRICE_SMS_SEGMENT",
  "DELIVERY_CURRENCY", "DELIVERY_UNSUBSCRIBE_BASE_URL", "DELIVERY_RUN_BUDGET_MS", "DELIVERY_CLAIM_LIMIT",
  "DELIVERY_PROVIDER_TIMEOUT_MS", "DELIVERY_INTERVAL_MS", "SMS_PROVIDER",
  "RESEND_API_KEY", "RESEND_FROM", "RESEND_REPLY_TO", "RESEND_BASE_URL",
  "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_BASE_URL", "TWILIO_OUTCOME_WAIT_MS",
  // billing
  "BILLING_WORKER", "BILLING_DATABASE_URL", "BILLING_CLAIM_LIMIT", "BILLING_RUN_BUDGET_MS", "BILLING_INTERVAL_MS",
  // calendar
  "CALENDAR_WORKER", "CALENDAR_DATABASE_URL", "CALENDAR_RUN_BUDGET_MS", "CALENDAR_INTERVAL_MS",
  "GOOGLE_TOKEN_PRIVATE_KEY", "GOOGLE_WEBHOOK_URL", "GOOGLE_EVENT_TITLE",
  // activepieces runner (the API keeps ACTIVEPIECES_KEY_SECRET and its previous secret for the owner routes)
  "ACTIVEPIECES_WEBHOOK_WORKER", "ACTIVEPIECES_DATABASE_URL", "ACTIVEPIECES_WORKER_ID", "ACTIVEPIECES_RUN_BUDGET_MS",
  "ACTIVEPIECES_CLAIM_LIMIT", "ACTIVEPIECES_REQUEST_TIMEOUT_MS", "ACTIVEPIECES_MAX_ATTEMPTS", "ACTIVEPIECES_INTERVAL_MS",
  // follow-up agent. While POST /v1/agents/followup/runs and the template-suggestion route stay unwired in
  // createServer these are worker-only; wiring them into the API needs a decision (async dispatch to the workers).
  "FOLLOWUP_AGENT", "FOLLOWUP_DATABASE_URL", "FOLLOWUP_SERVICE_DATABASE_URL", "FOLLOWUP_MODEL", "FOLLOWUP_SLOT_MINUTES",
  "FOLLOWUP_MAX_CANDIDATES", "FOLLOWUP_MODEL_TIMEOUT_MS", "FOLLOWUP_RUN_BUDGET_MS", "FOLLOWUP_INTERVAL_MS",
  "AGENT_MODEL_PERSONAL_DATA", "AGENT_MODEL_NO_PERSONAL_DATA", "AGENT_TEMPLATED", "AGENT_TEMPLATED_MAX_CANDIDATES",
  "AGENT_STALL_AFTER_MS", "CEREBRAS_API_KEY", "CEREBRAS_MODEL", "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "COMPOSIO_API_KEY",
  // enrichment worker (src/enrichment/config.ts, @zs/core enrichment/config.ts)
  "ENRICHMENT_WORKER", "ENRICHMENT_DATABASE_URL", "ENRICHMENT_WORKER_ID", "ENRICHMENT_CLAIM_LIMIT", "ENRICHMENT_MAX_ATTEMPTS",
  "ENRICHMENT_PROVIDER_TIMEOUT_MS", "ENRICHMENT_INTERVAL_MS", "TREG_TOKEN", "TREG_BASE_URL",
  // Not here: ENRICHMENT_PROVIDER, TREG_ARCHIVE_CONFIRMED_OFF, ENRICHMENT_DISABLED and the price and cap
  // variables. The API reads them (parseEnrichmentEnv in src/vercel.ts) as the service gate; they hold no secret.
  // image worker (src/images/config.ts); the API keeps IMAGE_ADAPTER and the adapter settings (parseImageEnv)
  "IMAGE_WORKER", "IMAGE_DATABASE_URL", "IMAGE_SERVICE_DATABASE_URL", "IMAGE_INTERVAL_MS",
  // build variables of the workers project
  ...CRON_SCHEDULE_VARIABLES,
];
