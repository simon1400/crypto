-- =====================================================================
-- Drop Forex Scanner + FX Trades modules.
--
-- Both modules removed 2026-05-09 after backtests confirmed no edge for
-- retail forex strategies (see runBacktest_forex_strategies / sessionBreakout
-- results — best PF=1.41 only on XAU NY-session, all majors net negative).
--
-- Backups: backups/forex_modules_backup_20260508_232743.sql contains the
-- ForexTrade rows (12 trades) and BotConfig snapshot.
-- =====================================================================

-- 1) Drop ForexTrade table
DROP TABLE IF EXISTS "ForexTrade";

-- 2) Drop forex-scanner fields from BotConfig
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "forexScanEnabled";
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "forexScanMinScore";
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "forexLastScanAt";

-- 3) Drop forex classification fields from GeneratedSignal
DROP INDEX IF EXISTS "GeneratedSignal_market_idx";
ALTER TABLE "GeneratedSignal" DROP COLUMN IF EXISTS "market";
ALTER TABLE "GeneratedSignal" DROP COLUMN IF EXISTS "session";
