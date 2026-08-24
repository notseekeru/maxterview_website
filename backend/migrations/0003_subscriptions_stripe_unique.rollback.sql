-- yoyo rollback for 0003_subscriptions_stripe_unique (read from 0003_subscriptions_stripe_unique.rollback.sql)
DROP INDEX IF EXISTS uq_subscriptions_stripe_id;
