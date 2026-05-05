-- LevelsPaperConfig: virtual paper trading config (singleton id=1)
CREATE TABLE "LevelsPaperConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startingDepositUsd" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "currentDepositUsd" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "riskPctPerTrade" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "feesRoundTripPct" DOUBLE PRECISION NOT NULL DEFAULT 0.04,
    "dailyLossLimitPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "weeklyLossLimitPct" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "maxConcurrentPositions" INTEGER NOT NULL DEFAULT 2,
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

    CONSTRAINT "LevelsPaperConfig_pkey" PRIMARY KEY ("id")
);

-- LevelsPaperTrade: one virtual trade per LevelsSignal (when paper mode enabled)
CREATE TABLE "LevelsPaperTrade" (
    "id" SERIAL NOT NULL,
    "signalId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "market" TEXT NOT NULL,
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
    "lastPriceCheck" DOUBLE PRECISION,
    "lastPriceCheckAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LevelsPaperTrade_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LevelsPaperTrade_status_symbol_idx" ON "LevelsPaperTrade"("status", "symbol");
CREATE INDEX "LevelsPaperTrade_openedAt_idx" ON "LevelsPaperTrade"("openedAt");
CREATE INDEX "LevelsPaperTrade_signalId_idx" ON "LevelsPaperTrade"("signalId");
