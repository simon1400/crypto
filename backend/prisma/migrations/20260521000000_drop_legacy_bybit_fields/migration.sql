-- Drop legacy Bybit credentials and fee-rate fields from BotConfig.
-- Daily Breakout LIVE C runs exclusively on Binance Futures, with fees
-- stored per-variant in BreakoutPaperConfig.feeTakerPct / feeMakerPct and
-- BreakoutLiveConfigC.feeTakerPct / feeMakerPct. The Bybit columns and
-- virtual balance tracker were only read by the now-deleted Settings UI
-- and Bybit service — both removed in the same change.

ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "apiKey";
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "apiSecret";
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "useTestnet";
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "takerFeeRate";
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "makerFeeRate";
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "virtualBalance";
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "virtualBalanceStart";
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "virtualStartedAt";
