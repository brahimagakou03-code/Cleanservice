/**
 * Lit prisma/dev.db (SQLite, projet local) et produit scripts/sql/02_data_from_sqlite.sql
 * (INSERT compatibles PostgreSQL). Exécuter après 01_schema_postgresql.sql.
 *
 * SQLITE_SOURCE : chemin alternatif vers le .db
 * SQL_DATA_OUT  : chemin du fichier SQL de sortie
 */
"use strict";

const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const root = path.join(__dirname, "..");
const sqlitePath = process.env.SQLITE_SOURCE || path.join(root, "prisma", "dev.db");
const outPath = process.env.SQL_DATA_OUT || path.join(root, "scripts", "sql", "02_data_from_sqlite.sql");

/** Colonnes booléennes (SQLite stocke 0/1). */
const BOOL_COLUMNS = {
  User: ["isActive"],
  Product: ["isActive", "portalRuptureStock"],
  Customer: ["isActive"],
  CustomerSite: ["isDefault", "isShipping", "isBilling"],
  Order: ["isInvoiced"],
  Notification: ["isRead"],
  PortalNotification: ["isRead"],
};

/** Colonnes Prisma @db DateTime : SQLite les stocke en ms depuis epoch (INTEGER). */
const TIMESTAMP_COLUMNS = new Set([
  "createdAt",
  "updatedAt",
  "lastLoginAt",
  "approvedAt",
  "requestedDeliveryDate",
  "issuedAt",
  "dueAt",
  "sentAt",
  "paidAt",
  "validFrom",
  "validTo",
]);

function isEpochMilliseconds(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === "number" && Number.isFinite(val)) {
    return val > 1e11 && val < 1e14;
  }
  if (typeof val === "string" && /^\d+$/.test(val)) {
    const n = Number(val);
    return n > 1e11 && n < 1e14;
  }
  return false;
}

function queryAll(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((c, i) => {
      obj[c] = row[i];
    });
    return obj;
  });
}

function tableExists(db, name) {
  const rows = queryAll(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ${JSON.stringify(name)}`
  );
  return rows.length > 0;
}

function formatValue(table, col, val) {
  if (val === null || val === undefined) return "NULL";
  const boolCols = BOOL_COLUMNS[table];
  if (boolCols && boolCols.includes(col)) {
    const n = Number(val);
    return n === 1 || val === true ? "TRUE" : "FALSE";
  }
  if (TIMESTAMP_COLUMNS.has(col) && isEpochMilliseconds(val)) {
    const ms = typeof val === "string" ? Number(val) : val;
    const sec = ms / 1000;
    return `(to_timestamp(${sec}))::timestamp(3)`;
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return "NULL";
    if (Number.isInteger(val)) return String(val);
    return String(val);
  }
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  const s = String(val);
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

function emitInsert(table, row) {
  const cols = Object.keys(row);
  const quotedCols = cols.map((c) => `"${c}"`).join(", ");
  const vals = cols.map((c) => formatValue(table, c, row[c])).join(", ");
  return `INSERT INTO "${table}" (${quotedCols}) VALUES (${vals});\n`;
}

function exportProductCategories(db, lines) {
  if (!tableExists(db, "ProductCategory")) return;
  const all = queryAll(db, 'SELECT * FROM "ProductCategory"');
  if (!all.length) return;
  const remaining = new Map(all.map((r) => [r.id, r]));
  while (remaining.size) {
    const batch = [];
    for (const [, row] of remaining) {
      const pid = row.parentId;
      const noParent = pid === null || pid === undefined || pid === "";
      const parentDone = !noParent && !remaining.has(pid);
      if (noParent || parentDone) batch.push(row);
    }
    if (!batch.length) {
      lines.push("-- ERREUR: ProductCategory — cycle ou parent manquant, export partiel.\n");
      break;
    }
    for (const row of batch) {
      lines.push(emitInsert("ProductCategory", row));
      remaining.delete(row.id);
    }
  }
}

function exportInvoices(db, lines) {
  if (!tableExists(db, "Invoice")) return;
  const all = queryAll(db, 'SELECT * FROM "Invoice"');
  if (!all.length) return;
  const wave1 = all.filter((r) => !r.originalInvoiceId);
  const wave2 = all.filter((r) => r.originalInvoiceId);
  for (const row of wave1) lines.push(emitInsert("Invoice", row));
  for (const row of wave2) lines.push(emitInsert("Invoice", row));
}

/** Tables sans dépendance vers Invoice (Invoice doit exister avant InvoiceLine / Payment). */
const TABLES_BEFORE_INVOICE = [
  "Product",
  "Customer",
  "CustomerSite",
  "CustomerPriceList",
  "Order",
  "OrderLine",
  "OrderStatusHistory",
  "OrderLineStockReservation",
];

const TABLES_AFTER_INVOICE = [
  "InvoiceLine",
  "Payment",
  "InvoiceSequence",
  "Notification",
  "PortalNotification",
  "EmailQueue",
];

async function main() {
  const header =
    "-- Données exportées depuis SQLite (projet local).\n" +
    "-- Exécuter sur PostgreSQL / Supabase APRÈS scripts/sql/01_schema_postgresql.sql\n" +
    "-- Base vide recommandée (sinon risque de conflits d’unicité).\n\n" +
    "BEGIN;\n\n";

  const footer = "\nCOMMIT;\n";

  if (!fs.existsSync(sqlitePath)) {
    const msg =
      `-- Aucun fichier SQLite trouvé : ${sqlitePath.replace(/\\/g, "/")}\n` +
      `-- Lance l’app avec DATABASE_URL=file:./dev.db puis seed, ou copie ton dev.db ici, puis :\n` +
      `--   npm run sql:export-local\n`;
    fs.writeFileSync(outPath, header + msg + footer, "utf8");
    console.warn("Export données : fichier SQLite absent, SQL d’en-tête seulement écrit :", outPath);
    return;
  }

  const wasmDir = path.join(root, "node_modules", "sql.js", "dist");
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file),
  });

  const fileBuffer = fs.readFileSync(sqlitePath);
  const db = new SQL.Database(fileBuffer);

  const lines = [header];

  try {
    if (tableExists(db, "Organization")) {
      for (const row of queryAll(db, 'SELECT * FROM "Organization"')) {
        lines.push(emitInsert("Organization", row));
      }
    }
    for (const t of ["User", "Client"]) {
      if (!tableExists(db, t)) continue;
      for (const row of queryAll(db, `SELECT * FROM "${t}"`)) {
        lines.push(emitInsert(t, row));
      }
    }
    exportProductCategories(db, lines);
    for (const t of TABLES_BEFORE_INVOICE) {
      if (!tableExists(db, t)) continue;
      for (const row of queryAll(db, `SELECT * FROM "${t}"`)) {
        lines.push(emitInsert(t, row));
      }
    }
    exportInvoices(db, lines);
    for (const t of TABLES_AFTER_INVOICE) {
      if (!tableExists(db, t)) continue;
      for (const row of queryAll(db, `SELECT * FROM "${t}"`)) {
        lines.push(emitInsert(t, row));
      }
    }
  } finally {
    db.close();
  }

  lines.push(footer);
  fs.writeFileSync(outPath, lines.join(""), "utf8");
  console.log("Écrit :", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
