-- Add auto-trailing-SL toggle to LevelsPaperConfig
ALTER TABLE "LevelsPaperConfig" ADD COLUMN "autoTrailingSL" BOOLEAN NOT NULL DEFAULT false;

-- Add per-trade overrides for fees and trailing-SL
ALTER TABLE "LevelsPaperTrade" ADD COLUMN "feesRoundTripPct" DOUBLE PRECISION;
ALTER TABLE "LevelsPaperTrade" ADD COLUMN "autoTrailingSL" BOOLEAN;
