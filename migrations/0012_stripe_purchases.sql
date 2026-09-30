-- Web purchases are settled by Stripe instead of RevenueCat's in_app_purchase
-- events, so they need their own idempotency and retry bookkeeping.
--
-- Every accepted Stripe event is recorded here keyed by the Stripe event id.
-- A grant that could not be applied immediately (typically because the
-- RevenueCat customer does not exist yet) stays `pending` and is retried by the
-- existing 10-minute cron, mirroring `pending_refunds`.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status
  ON stripe_webhook_events(status, updated_at);
