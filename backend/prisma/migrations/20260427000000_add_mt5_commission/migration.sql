-- Add MT5 commission per lot (round-turn, USD) for break-even calculation
ALTER TABLE "BotConfig" ADD COLUMN "mt5CommissionPerLot" DOUBLE PRECISION NOT NULL DEFAULT 0;
