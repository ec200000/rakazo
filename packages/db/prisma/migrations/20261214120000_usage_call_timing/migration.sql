-- How long each model call took, how long until its first output, and the model's context
-- window, for the answer breakdown shown on hover over an answer's time.
ALTER TABLE "usage_records" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "usage_records" ADD COLUMN "firstTokenMs" INTEGER;
ALTER TABLE "usage_records" ADD COLUMN "contextWindow" INTEGER;

CREATE INDEX "usage_records_runId_idx" ON "usage_records"("runId");
