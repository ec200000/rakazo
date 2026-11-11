-- The git repository a bot works on, its base branch, and the branch its person chose.
ALTER TABLE "bots"
  ADD COLUMN "repoUrl" TEXT,
  ADD COLUMN "repoBaseBranch" TEXT,
  ADD COLUMN "repoBranch" TEXT;
