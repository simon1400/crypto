-- Add author-reported final outcome fields (for ETG reply updates)
ALTER TABLE "Signal" ADD COLUMN "authorStatus" TEXT;
ALTER TABLE "Signal" ADD COLUMN "authorPnlPct" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "authorPeriod" TEXT;
ALTER TABLE "Signal" ADD COLUMN "authorClosedAt" TIMESTAMP(3);
ALTER TABLE "Signal" ADD COLUMN "authorUpdateMsgId" INTEGER;
ALTER TABLE "Signal" ADD COLUMN "averageEntryPrice" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "allEntriesFilled" BOOLEAN NOT NULL DEFAULT false;
