-- ===================================================================
-- Daily Breakout strategy (replaces Levels in prod, 2026-05-07).
-- Range = first 3h UTC of each day → breakout in remaining 21h.
-- ===================================================================

CREATE TABLE "BreakoutSignal" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "rangeHigh" DOUBLE PRECISION NOT NULL,
    "rangeLow" DOUBLE PRECISION NOT NULL,
    "rangeSize" DOUBLE PRECISION NOT NULL,
    "rangeDate" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "initialStop" DOUBLE PRECISION NOT NULL,
    "currentStop" DOUBLE PRECISION NOT NULL,
    "tpLadder" JSONB NOT NULL,
    "volumeAtBreakout" DOUBLE PRECISION NOT NULL,
    "avgVolume" DOUBLE PRECISION NOT NULL,
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

    CONSTRAINT "BreakoutSignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BreakoutSignal_status_symbol_idx" ON "BreakoutSignal"("status", "symbol");
CREATE INDEX "BreakoutSignal_createdAt_idx" ON "BreakoutSignal"("createdAt");
CREATE INDEX "BreakoutSignal_rangeDate_symbol_idx" ON "BreakoutSignal"("rangeDate", "symbol");

CREATE TABLE "BreakoutConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "symbolsEnabled" JSONB NOT NULL DEFAULT '[]',
    "rangeBars" INTEGER NOT NULL DEFAULT 36,
    "volumeMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "cronIntervalMin" INTEGER NOT NULL DEFAULT 5,
    "notifyOnNew" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnClose" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" TIMESTAMP(3),
    "lastScanResult" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakoutConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BreakoutPaperConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startingDepositUsd" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "currentDepositUsd" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "riskPctPerTrade" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "feesRoundTripPct" DOUBLE PRECISION NOT NULL DEFAULT 0.08,
    "autoTrailingSL" BOOLEAN NOT NULL DEFAULT false,
    "dailyLossLimitPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "weeklyLossLimitPct" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "maxConcurrentPositions" INTEGER NOT NULL DEFAULT 10,
    "maxPositionsPerSymbol" INTEGER NOT NULL DEFAULT 1,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "totalWins" INTEGER NOT NULL DEFAULT 0,
    "totalLosses" INTEGER NOT NULL DEFAULT 0,
    "totalPnLUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "peakDepositUsd" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "maxDrawdownPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resetAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakoutPaperConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BreakoutPaperTrade" (
    "id" SERIAL NOT NULL,
    "signalId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "initialStop" DOUBLE PRECISION NOT NULL,
    "currentStop" DOUBLE PRECISION NOT NULL,
    "tpLadder" JSONB NOT NULL,
    "depositAtEntryUsd" DOUBLE PRECISION NOT NULL,
    "riskUsd" DOUBLE PRECISION NOT NULL,
    "positionSizeUsd" DOUBLE PRECISION NOT NULL,
    "positionUnits" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closes" JSONB NOT NULL DEFAULT '[]',
    "realizedR" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realizedPnlUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feesPaidUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPnlUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feesRoundTripPct" DOUBLE PRECISION,
    "autoTrailingSL" BOOLEAN,
    "lastPriceCheck" DOUBLE PRECISION,
    "lastPriceCheckAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakoutPaperTrade_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BreakoutPaperTrade_status_symbol_idx" ON "BreakoutPaperTrade"("status", "symbol");
CREATE INDEX "BreakoutPaperTrade_openedAt_idx" ON "BreakoutPaperTrade"("openedAt");
CREATE INDEX "BreakoutPaperTrade_signalId_idx" ON "BreakoutPaperTrade"("signalId");
