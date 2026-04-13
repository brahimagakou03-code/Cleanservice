const { AsyncLocalStorage } = require("node:async_hooks");
const { PrismaClient } = require("@prisma/client");

/**
 * Netlify / Supabase : sans sslmode=require, pg peut échouer (P1001 « Can't reach database »).
 * Pooler (6543) : ajoute pgbouncer=true si absent (requis par Prisma avec PgBouncer transaction).
 */
function normalizeDatabaseUrl(raw) {
  if (!raw || typeof raw !== "string") return raw;
  let u = raw.trim();
  if (!u.includes("supabase.co")) return u;

  if (!/[?&]sslmode=/i.test(u)) {
    u += u.includes("?") ? "&sslmode=require" : "?sslmode=require";
  }

  const isPooler = /:6543([/?]|$)/.test(u) || u.includes("pooler.supabase.com");
  if (isPooler && !/[?&]pgbouncer=/i.test(u)) {
    u += u.includes("?") ? "&pgbouncer=true" : "?pgbouncer=true";
  }

  if (process.env.NETLIFY === "true" && isPooler && !/[?&]connection_limit=/i.test(u)) {
    u += u.includes("?") ? "&connection_limit=1" : "?connection_limit=1";
  }

  return u;
}

const resolvedDbUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);

if (process.env.NETLIFY === "true" && process.env.DATABASE_URL) {
  const d = process.env.DATABASE_URL;
  if (/db\.[^.]+\.supabase\.co:5432/.test(d) && !/:6543/.test(d)) {
    console.warn(
      "[db] Netlify : DATABASE_URL utilise la connexion directe (db…:5432). Préférez l’URI « Transaction pooler » (port 6543) depuis Supabase → Connect → Connection string."
    );
  }
}

const prisma = resolvedDbUrl
  ? new PrismaClient({ datasources: { db: { url: resolvedDbUrl } } })
  : new PrismaClient();
const requestContext = new AsyncLocalStorage();
const TENANT_MODELS = new Set([
  "User",
  "Client",
  "Product",
  "ProductCategory",
  "Order",
  "OrderLine",
  "OrderStatusHistory",
  "Invoice",
  "InvoiceLine",
  "Payment",
  "InvoiceSequence",
  "Notification",
  "EmailQueue",
  "Customer",
  "CustomerSite",
  "CustomerPriceList",
  "PortalNotification",
  "OrderLineStockReservation",
]);

function andWhere(existingWhere, orgId) {
  if (!existingWhere) {
    return { organizationId: orgId };
  }
  return { AND: [existingWhere, { organizationId: orgId }] };
}

prisma.$use(async (params, next) => {
  const context = requestContext.getStore();
  const orgId = context?.organizationId;
  const skipTenant = context?.skipTenant === true;

  if (skipTenant || !orgId || !params.model || !TENANT_MODELS.has(params.model)) {
    return next(params);
  }

  if (["findMany", "findFirst", "findUnique", "count", "aggregate"].includes(params.action)) {
    params.args = params.args || {};
    /* findUnique n'accepte qu'un seul critère unique ; le filtre tenant ajoute un AND. */
    if (params.action === "findUnique") {
      params.action = "findFirst";
    }
    params.args.where = andWhere(params.args.where, orgId);
  }

  /* delete/update exigent un WhereUniqueInput ; le filtre tenant ajoute un AND invalide. */
  if (params.action === "delete") {
    params.action = "deleteMany";
  }
  if (params.action === "update") {
    if (params.args?.include) {
      delete params.args.include;
    }
    params.action = "updateMany";
  }
  if (["updateMany", "deleteMany"].includes(params.action)) {
    params.args = params.args || {};
    params.args.where = andWhere(params.args.where, orgId);
  }

  if (params.action === "upsert") {
    params.args = params.args || {};
    params.args.where = andWhere(params.args.where, orgId);
    params.args.create = { ...(params.args.create || {}), organizationId: orgId };
    params.args.update = params.args.update || {};
  }

  if (params.action === "create") {
    params.args = params.args || {};
    params.args.data = { ...(params.args.data || {}), organizationId: orgId };
  }

  if (params.action === "createMany") {
    params.args = params.args || {};
    const data = params.args.data || [];
    params.args.data = Array.isArray(data)
      ? data.map((item) => ({ ...item, organizationId: orgId }))
      : { ...data, organizationId: orgId };
  }

  return next(params);
});

/**
 * Exécute une requête Prisma sans filtre tenant (liste des franchisés, etc.).
 * À utiliser uniquement depuis des routes protégées « administrateur plateforme ».
 */
function withSkipTenant(fn) {
  const store = requestContext.getStore();
  if (!store) return fn();
  return requestContext.run({ ...store, skipTenant: true }, fn);
}

module.exports = { prisma, requestContext, withSkipTenant };
