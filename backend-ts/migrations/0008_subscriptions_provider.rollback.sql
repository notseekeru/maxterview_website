DROP INDEX IF EXISTS uq_subscriptions_provider_subscription_id;

ALTER TABLE subscriptions DROP COLUMN IF EXISTS provider_plan_id;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS provider_subscription_id;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS provider;
ALTER TABLE subscriptions RENAME COLUMN provider_customer_id TO stripe_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_stripe_id
    ON subscriptions (stripe_id) WHERE stripe_id <> '';
