-- Remove Near512 channel support
ALTER TABLE "BotConfig" DROP COLUMN IF EXISTS "near512Topics";

-- Purge all Near512 and BinanceKillers signals (channels no longer supported)
DELETE FROM "Signal" WHERE "channel" IN ('Near512-LowCap', 'Near512-MidHigh', 'Near512-Spot', 'BinanceKillers');
