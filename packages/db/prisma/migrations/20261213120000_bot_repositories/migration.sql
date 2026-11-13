-- Several repositories per bot; the single repository moves into the list.
ALTER TABLE "bots" ADD COLUMN "repos" JSONB;
UPDATE "bots"
SET "repos" = jsonb_build_array(
  jsonb_build_object('url', "repoUrl", 'baseBranch', "repoBaseBranch", 'jenkinsJob', NULL)
)
WHERE "repoUrl" IS NOT NULL;

-- Routines Rakazo manages for a bot (its branch's Jenkins build, a pull request it opened).
ALTER TABLE "routines" ADD COLUMN "autoKey" TEXT;
CREATE UNIQUE INDEX "routines_botId_autoKey_key" ON "routines"("botId", "autoKey");
