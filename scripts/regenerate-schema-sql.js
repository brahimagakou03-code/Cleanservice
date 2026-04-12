/**
 * Régénère scripts/sql/01_schema_postgresql.sql depuis prisma/schema.prisma (PostgreSQL).
 * Ne nécessite pas de serveur Postgres en marche.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outFile = path.join(root, "scripts", "sql", "01_schema_postgresql.sql");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://placeholder:placeholder@127.0.0.1:5432/postgres";

const cmd =
  'npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script -o scripts/sql/01_schema_postgresql.sql';

execSync(cmd, { stdio: "inherit", cwd: root, env: { ...process.env } });

const body = fs.readFileSync(outFile, "utf8");
const header =
  "-- Schéma PostgreSQL généré par Prisma (Clean Service).\n" +
  "-- Régénérer : npm run sql:schema\n" +
  "-- Appliquer sur Supabase (SQL Editor) ou : psql \"$DATABASE_URL\" -f scripts/sql/01_schema_postgresql.sql\n\n";

fs.writeFileSync(outFile, header + body, "utf8");
console.log("Écrit :", outFile);
