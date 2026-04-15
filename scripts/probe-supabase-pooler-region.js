require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

/** Supavisor transaction : même hôte db.*, port 6543, user postgres (doc Supabase 2024+). */
function toTransactionOnDbHost(databaseUrl) {
  let u;
  try {
    u = new URL(databaseUrl.trim().replace(/^postgresql:/i, "postgres:"));
  } catch {
    return null;
  }
  if (!/^db\.[^.]+\.supabase\.co$/i.test(u.hostname)) return null;
  u.port = "6543";
  if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
  u.searchParams.set("pgbouncer", "true");
  return u.toString().replace(/^postgres:/i, "postgresql:");
}

/** Session pooler : aws-0-REGION.pooler.supabase.com:5432, user postgres.ref */
function toSessionPoolerUrl(databaseUrl, region) {
  let u;
  try {
    u = new URL(databaseUrl.trim().replace(/^postgresql:/i, "postgres:"));
  } catch {
    return null;
  }
  const m = u.hostname.match(/^db\.([^.]+)\.supabase\.co$/i);
  if (!m) return null;
  const ref = m[1];
  let user = decodeURIComponent(u.username || "");
  if (user === "postgres") user = `postgres.${ref}`;
  u.username = encodeURIComponent(user);
  u.hostname = `aws-0-${region}.pooler.supabase.com`;
  u.port = "5432";
  if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
  u.searchParams.delete("pgbouncer");
  return u.toString().replace(/^postgres:/i, "postgresql:");
}

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("DATABASE_URL manquant.");
    process.exit(1);
  }

  const txUrl = toTransactionOnDbHost(raw);
  if (txUrl) {
    const prisma = new PrismaClient({ datasources: { db: { url: txUrl } } });
    try {
      await prisma.$connect();
      console.log("TX_ON_DB_HOST_OK");
      await prisma.$disconnect();
      process.exit(0);
    } catch (e) {
      const msg = e?.message ? e.message.split("\n")[0] : String(e);
      console.log("TX_ON_DB_HOST_FAIL -", msg.slice(0, 160));
    }
    await prisma.$disconnect().catch(() => {});
  }

  const regions = [
    "eu-central-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-north-1",
    "us-east-1",
    "us-west-1",
    "us-west-2",
    "ap-south-1",
    "ap-southeast-1",
  ];
  for (const r of regions) {
    const url = toSessionPoolerUrl(raw, r);
    if (!url) {
      console.error("DATABASE_URL n’est pas une URL directe db.*.supabase.co — rien à convertir.");
      process.exit(1);
    }
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$connect();
      console.log("SESSION_POOLER_OK", r);
      await prisma.$disconnect();
      process.exit(0);
    } catch (e) {
      const msg = e?.message ? e.message.split("\n")[0] : String(e);
      console.log("SESSION_POOLER_FAIL", r, "-", msg.slice(0, 140));
    }
    await prisma.$disconnect().catch(() => {});
  }
  process.exit(2);
}

main();
