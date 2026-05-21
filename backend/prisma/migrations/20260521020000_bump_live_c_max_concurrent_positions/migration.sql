-- Reset maxConcurrentPositions back to the strategy spec value (20). A bump
-- to 50 was committed by mistake — Daily Breakout strategy has always been
-- capped at 20 concurrent open positions. PENDING_LIMIT rows are not counted
-- against this cap (see aggTrade fill-time gate), only filled positions
-- (OPEN / TP1_HIT / TP2_HIT) are.
ALTER TABLE "BreakoutLiveConfigC" ALTER COLUMN "maxConcurrentPositions" SET DEFAULT 20;
UPDATE "BreakoutLiveConfigC" SET "maxConcurrentPositions" = 20 WHERE "maxConcurrentPositions" <> 20;
