-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0008_subscriptions_provider.rollback.sql.)
-- M10 provider swap: Stripe -> PayMongo. Columns are renamed provider-agnostic so a second
-- provider (merchant-of-record for global/USD) is a module + a row, not another rename.
--   provider_customer_id     cus_…  (was stripe_id: cus_…)
--   provider_subscription_id subs_… — what cancel/webhook resolution needs
--   provider_plan_id         plan_…

ALTER TABLE subscriptions RENAME COLUMN stripe_id TO provider_customer_id;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'paymongo';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_plan_id TEXT NOT NULL DEFAULT '';

-- 0003's unique index was named for Stripe; replace it with the subscription-scoped one that
-- payments._owner_for() resolves owners through (partial: default-empty rows never collide).
DROP INDEX IF EXISTS uq_subscriptions_stripe_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_provider_subscription_id
    ON subscriptions (provider_subscription_id) WHERE provider_subscription_id <> '';
