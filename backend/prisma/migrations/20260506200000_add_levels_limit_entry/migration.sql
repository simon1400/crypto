-- Add LIMIT entry mode fields to LevelsSignal
ALTER TABLE "LevelsSignal" ADD COLUMN "entryMode" TEXT NOT NULL DEFAULT 'MARKET';
ALTER TABLE "LevelsSignal" ADD COLUMN "entryFilledAt" TIMESTAMP(3);
ALTER TABLE "LevelsSignal" ADD COLUMN "pendingExpiresAt" TIMESTAMP(3);
