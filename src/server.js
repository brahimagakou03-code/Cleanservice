require("dotenv").config();

/* Supabase / Postgres en local (surtout Windows) : IPv6 peut échouer alors qu’IPv4 fonctionne. */
const dns = require("node:dns");
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* Node très ancien : ignorer */
}

const { app } = require("./app");
const { prisma, getDatabaseUrlConfigError } = require("./db");
const { startInvoiceJobs } = require("./jobs/invoiceJobs");
const { startEmailQueueJob } = require("./jobs/emailQueueJob");

const port = Number(process.env.PORT || 3000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectDatabaseWithRetry() {
  const attempts = Math.max(1, Number(process.env.DB_CONNECT_RETRIES || 3));
  const delayMs = Math.max(0, Number(process.env.DB_CONNECT_RETRY_DELAY_MS || 2000));
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await prisma.$connect();
      return true;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

const urlErr = getDatabaseUrlConfigError(process.env.DATABASE_URL);
if (urlErr) {
  console.error("[db] Configuration :", urlErr);
  process.exit(1);
}

app.listen(port, async () => {
  try {
    await connectDatabaseWithRetry();
    console.log("Base de donnees : connectee.");
    startInvoiceJobs();
    startEmailQueueJob();
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("Base de donnees : impossible de se connecter —", msg);
    console.error(
      "Conseils : verifier que le projet Supabase est actif ; utiliser l’URI « Transaction pooler » (port 6543) " +
        "dans Supabase → Project Settings → Database ; sslmode=require est applique automatiquement pour les hotes supabase.co."
    );
    if (process.env.ALLOW_START_WITHOUT_DB === "true") {
      console.warn(
        "ALLOW_START_WITHOUT_DB=true : le serveur demarre sans base (taches planifiees desactivees). La plupart des pages necessitent la base."
      );
    } else {
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    }
  }
  console.log(`Serveur demarre sur http://localhost:${port}`);
});
