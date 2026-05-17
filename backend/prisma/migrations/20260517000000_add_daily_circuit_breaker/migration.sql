-- Daily circuit breaker: per-variant -8R OR -10% deposit per UTC day.
-- Replaces dormant dailyLossLimitPct fields (existed but were never enforced).
-- See dailyBreakoutPaperTrader.isCircuitBreakerTripped for enforcement.

ALTER TABLE "BreakoutPaperConfig"  ADD COLUMN "dailyLossLimitR" DOUBLE PRECISION NOT NULL DEFAULT 8;
ALTER TABLE "BreakoutPaperConfigB" ADD COLUMN "dailyLossLimitR" DOUBLE PRECISION NOT NULL DEFAULT 8;
ALTER TABLE "BreakoutPaperConfigC" ADD COLUMN "dailyLossLimitR" DOUBLE PRECISION NOT NULL DEFAULT 8;

-- Raise the existing % limit from 5% to 10% (5% trips too often on normal swings).
UPDATE "BreakoutPaperConfig"  SET "dailyLossLimitPct" = 10 WHERE "dailyLossLimitPct" = 5;
UPDATE "BreakoutPaperConfigB" SET "dailyLossLimitPct" = 10 WHERE "dailyLossLimitPct" = 5;
UPDATE "BreakoutPaperConfigC" SET "dailyLossLimitPct" = 10 WHERE "dailyLossLimitPct" = 5;
