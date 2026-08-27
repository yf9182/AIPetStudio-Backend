-- Track whether the one-time welcome bonus was confirmed by RevenueCat.
ALTER TABLE users ADD COLUMN welcome_bonus_granted_at TEXT;

-- Users with a recorded generation debit already completed the old onboarding
-- flow successfully; do not grant the welcome bonus a second time after this
-- migration. Users without a debit remain eligible for the idempotent sync.
UPDATE users
SET welcome_bonus_granted_at = created_at
WHERE welcome_bonus_granted_at IS NULL
  AND id IN (SELECT user_id FROM credit_ledger WHERE reason = 'signup')
  AND id IN (SELECT user_id FROM credit_ledger WHERE reason = 'generation_debit');
