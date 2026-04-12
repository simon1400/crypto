-- AlterTable: GeneratedSignal — add 3-layer scoring and trade lifecycle fields
ALTER TABLE "GeneratedSignal" ADD COLUMN "initialStop" DOUBLE PRECISION;
ALTER TABLE "GeneratedSignal" ADD COLUMN "currentStop" DOUBLE PRECISION;
ALTER TABLE "GeneratedSignal" ADD COLUMN "setupScore" INTEGER;
ALTER TABLE "GeneratedSignal" ADD COLUMN "setupCategory" TEXT;
ALTER TABLE "GeneratedSignal" ADD COLUMN "executionType" TEXT;
ALTER TABLE "GeneratedSignal" ADD COLUMN "entryModel" TEXT;
ALTER TABLE "GeneratedSignal" ADD COLUMN "stopMovedToBe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GeneratedSignal" ADD COLUMN "stopMoveReason" TEXT;
ALTER TABLE "GeneratedSignal" ADD COLUMN "trailingActivated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GeneratedSignal" ADD COLUMN "trailingActivationTime" TIMESTAMP(3);
ALTER TABLE "GeneratedSignal" ADD COLUMN "tp1HitTimestamp" TIMESTAMP(3);
ALTER TABLE "GeneratedSignal" ADD COLUMN "tp2HitTimestamp" TIMESTAMP(3);
ALTER TABLE "GeneratedSignal" ADD COLUMN "tp3HitTimestamp" TIMESTAMP(3);
ALTER TABLE "GeneratedSignal" ADD COLUMN "exitReason" TEXT;
ALTER TABLE "GeneratedSignal" ADD COLUMN "timeInTradeMin" INTEGER;

-- AlterTable: Trade — add initial_stop, trade lifecycle, and outcome tracking
ALTER TABLE "Trade" ADD COLUMN "initialStop" DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN "currentStop" DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN "stopMovedToBe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Trade" ADD COLUMN "stopMoveReason" TEXT;
ALTER TABLE "Trade" ADD COLUMN "trailingActivated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Trade" ADD COLUMN "trailingActivationTime" TIMESTAMP(3);
ALTER TABLE "Trade" ADD COLUMN "tp1HitTimestamp" TIMESTAMP(3);
ALTER TABLE "Trade" ADD COLUMN "tp2HitTimestamp" TIMESTAMP(3);
ALTER TABLE "Trade" ADD COLUMN "tp3HitTimestamp" TIMESTAMP(3);
ALTER TABLE "Trade" ADD COLUMN "exitReason" TEXT;
ALTER TABLE "Trade" ADD COLUMN "timeInTradeMin" INTEGER;
ALTER TABLE "Trade" ADD COLUMN "mfe" DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN "mae" DOUBLE PRECISION;

-- Backfill: set initialStop = stopLoss for existing records (preserving original SL)
UPDATE "GeneratedSignal" SET "initialStop" = "stopLoss" WHERE "initialStop" IS NULL;
UPDATE "GeneratedSignal" SET "currentStop" = "stopLoss" WHERE "currentStop" IS NULL;
UPDATE "Trade" SET "initialStop" = "stopLoss" WHERE "initialStop" IS NULL;
UPDATE "Trade" SET "currentStop" = "stopLoss" WHERE "currentStop" IS NULL;
