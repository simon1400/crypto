-- Per-UTC-date EOD wallet snapshot map. Written by runEodTick after EOD-FLAT
-- closes all positions, so it represents end-of-day equity, not intraday peak.
ALTER TABLE "BreakoutLiveConfigC"
  ADD COLUMN "eodEquityByDate" JSONB NOT NULL DEFAULT '{}'::jsonb;
