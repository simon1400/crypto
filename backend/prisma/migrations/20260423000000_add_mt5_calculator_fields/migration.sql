-- Add MT5 calculator fields (forex/gold lot size calculator)
ALTER TABLE "BotConfig" ADD COLUMN "mt5Balance" DOUBLE PRECISION;
ALTER TABLE "BotConfig" ADD COLUMN "mt5RiskPct" DOUBLE PRECISION NOT NULL DEFAULT 2;
