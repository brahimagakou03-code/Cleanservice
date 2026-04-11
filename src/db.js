const { AsyncLocalStorage } = require("node:async_hooks");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
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

  if (!orgId || !params.model || !TENANT_MODELS.has(params.model)) {
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

module.exports = { prisma, requestContext };
