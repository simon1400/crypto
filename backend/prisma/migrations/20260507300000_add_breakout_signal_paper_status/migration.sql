-- Track paper-trader outcome on each signal so the UI can show why a signal didn't open.
ALTER TABLE "BreakoutSignal"
  ADD COLUMN "paperStatus"    TEXT,
  ADD COLUMN "paperReason"    TEXT,
  ADD COLUMN "paperUpdatedAt" TIMESTAMP(3);
