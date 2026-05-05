-- LevelsSignal: live signals from V2 levels engine (fractal swings + PDH/PDL/PWH/PWL + Fibo)
CREATE TABLE "LevelsSignal" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "level" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "initialStop" DOUBLE PRECISION NOT NULL,
    "currentStop" DOUBLE PRECISION NOT NULL,
    "tpLadder" JSONB NOT NULL,
    "isFiboConfluence" BOOLEAN NOT NULL DEFAULT false,
    "fiboImpulse" JSONB,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "closes" JSONB NOT NULL DEFAULT '[]',
    "realizedR" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastPriceCheck" DOUBLE PRECISION,
    "lastPriceCheckAt" TIMESTAMP(3),
    "notifiedTelegram" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LevelsSignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LevelsSignal_status_symbol_idx" ON "LevelsSignal"("status", "symbol");
CREATE INDEX "LevelsSignal_market_status_idx" ON "LevelsSignal"("market", "status");
CREATE INDEX "LevelsSignal_createdAt_idx" ON "LevelsSignal"("createdAt");

-- LevelsConfig: singleton row id=1 with on/off + per-symbol enabled list
CREATE TABLE "LevelsConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "symbolsEnabled" JSONB NOT NULL DEFAULT '[]',
    "cronIntervalMin" INTEGER NOT NULL DEFAULT 5,
    "expiryHours" INTEGER NOT NULL DEFAULT 24,
    "notifyOnNew" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnClose" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" TIMESTAMP(3),
    "lastScanResult" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LevelsConfig_pkey" PRIMARY KEY ("id")
);
