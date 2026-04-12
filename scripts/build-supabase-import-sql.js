/**
 * Régénère le schéma Prisma (PostgreSQL), exporte prisma/dev.db → INSERT,
 * puis assemble des fichiers SQL pour Supabase (éditeur SQL).
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const schemaPath = path.join(root, "scripts", "sql", "01_schema_postgresql.sql");
const dataPath = path.join(root, "scripts", "sql", "02_data_from_sqlite.sql");
const outFull = path.join(root, "scripts", "sql", "supabase_full_import.sql");
const outReset = path.join(root, "scripts", "sql", "supabase_reset_and_import.sql");
const outDataOnly = path.join(root, "scripts", "sql", "supabase_data_only.sql");

/** DROP enfant → parent (évite les erreurs de clé étrangère). */
const DROP_APP_TABLES = [
  "Payment",
  "InvoiceLine",
  "Invoice",
  "OrderLineStockReservation",
  "OrderLine",
  "OrderStatusHistory",
  "Order",
  "PortalNotification",
  "CustomerSite",
  "Notification",
  "EmailQueue",
  "InvoiceSequence",
  "CustomerPriceList",
  "Product",
  "ProductCategory",
  "Client",
  "User",
  "Customer",
  "Organization",
];

execSync("node scripts/regenerate-schema-sql.js", { cwd: root, stdio: "inherit", env: process.env });
execSync("node scripts/export-sqlite-to-pg-sql.js", { cwd: root, stdio: "inherit", env: process.env });

const schema = fs.readFileSync(schemaPath, "utf8");
const data = fs.readFileSync(dataPath, "utf8");

const dropBlock =
  "-- Supprime les tables applicatives Prisma si elles existent déjà (ex. après prisma db push).\n" +
  "-- N’affecte pas auth.* ni les autres schémas Supabase.\n" +
  DROP_APP_TABLES.map((t) => `DROP TABLE IF EXISTS "${t}" CASCADE;`).join("\n") +
  "\n\n";

/** Fichier principal : DROP puis CREATE (évite 42P07 si db push a déjà créé les tables). */
const headerFull =
  "-- =============================================================================\n" +
  "-- Import Supabase — FICHIER À COLLER ICI (schéma + données projet local)\n" +
  "-- Généré : npm run sql:supabase-import → supabase_full_import.sql\n" +
  "--\n" +
  "-- Étape 1 : DROP des tables applicatives Prisma (si elles existent, ex. après prisma db push).\n" +
  "-- Étape 2 : CREATE schéma + INSERT depuis prisma/dev.db.\n" +
  "--\n" +
  "-- ATTENTION : efface toutes les données de ces tables (multi-tenant). Ne touche pas auth.*.\n" +
  "-- SQL Editor → Run. Puis DATABASE_URL dans .env (Settings → Database).\n" +
  "-- =============================================================================\n\n";

const headerReset =
  "-- =============================================================================\n" +
  "-- Même contenu que supabase_full_import.sql (DROP + schéma + données).\n" +
  "-- Généré : npm run sql:supabase-import\n" +
  "-- =============================================================================\n\n";

const headerDataOnly =
  "-- =============================================================================\n" +
  "-- Données seules (INSERT) — schéma déjà identique (prisma db push / 01_schema déjà appliqué)\n" +
  "-- Généré : npm run sql:supabase-import\n" +
  "--\n" +
  "-- Ne pas exécuter si la base contient déjà des données (conflits d’unicité).\n" +
  "-- =============================================================================\n\n";

const body = schema.trimEnd() + "\n\n-- === Données exportées depuis prisma/dev.db ===\n\n" + data.trim() + "\n";

const fullPayload = dropBlock + body;

fs.writeFileSync(outFull, headerFull + fullPayload, "utf8");
fs.writeFileSync(outReset, headerReset + fullPayload, "utf8");
fs.writeFileSync(outDataOnly, headerDataOnly + data.trim() + "\n", "utf8");

console.log("Écrit :", outFull, "(DROP + schéma + données — à utiliser dans Supabase)");
console.log("Écrit :", outReset, "(copie / alias)");
console.log("Écrit :", outDataOnly);
