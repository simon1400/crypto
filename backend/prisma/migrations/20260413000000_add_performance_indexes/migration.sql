-- AddIndex: Trade.status
CREATE INDEX "Trade_status_idx" ON "Trade"("status");

-- AddIndex: Trade.coin
CREATE INDEX "Trade_coin_idx" ON "Trade"("coin");

-- AddIndex: GeneratedSignal.status
CREATE INDEX "GeneratedSignal_status_idx" ON "GeneratedSignal"("status");

-- AddIndex: GeneratedSignal.coin
CREATE INDEX "GeneratedSignal_coin_idx" ON "GeneratedSignal"("coin");

-- AddIndex: Position.entryOrderId
CREATE INDEX "Position_entryOrderId_idx" ON "Position"("entryOrderId");

-- AddIndex: Position.signalId
CREATE INDEX "Position_signalId_idx" ON "Position"("signalId");
