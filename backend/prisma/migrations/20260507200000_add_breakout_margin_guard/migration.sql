-- Add margin guard config columns
ALTER TABLE "BreakoutPaperConfig"
  ADD COLUMN "targetMarginPct"      DOUBLE PRECISION NOT NULL DEFAULT 10,
  ADD COLUMN "marginGuardEnabled"   BOOLEAN          NOT NULL DEFAULT true,
  ADD COLUMN "marginGuardAutoClose" BOOLEAN          NOT NULL DEFAULT false;

-- Per-trade leverage / margin (nullable for backfill of existing rows)
ALTER TABLE "BreakoutPaperTrade"
  ADD COLUMN "leverage"  DOUBLE PRECISION,
  ADD COLUMN "marginUsd" DOUBLE PRECISION;
