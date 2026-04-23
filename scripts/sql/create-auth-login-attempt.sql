-- Table journal connexions (appliquer si `npx prisma migrate` n'est pas utilisé sur Supabase).

CREATE TABLE IF NOT EXISTS "AuthLoginAttempt" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "portal" TEXT NOT NULL,
  "email" TEXT,
  "success" BOOLEAN NOT NULL,
  "outcome" TEXT NOT NULL,
  "stepFailed" TEXT,
  "trace" TEXT,
  "detailMessage" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  CONSTRAINT "AuthLoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuthLoginAttempt_createdAt_idx" ON "AuthLoginAttempt" ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AuthLoginAttempt_portal_createdAt_idx" ON "AuthLoginAttempt" ("portal", "createdAt" DESC);
