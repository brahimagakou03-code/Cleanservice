const express = require("express");
const { prisma } = require("../db");
const { can } = require("../utils/rbac");
const { getPriceForCustomer } = require("../utils/pricing");
const { STATUS, computeOrderTotals, nextOrderNumber, availableActions, canStatusTransition } = require("../utils/orders");
const { TYPE, notifyUsersByRoles, notifyUser } = require("../utils/notifications");
const {
  pipePurchaseOrderPdf,
  vatBreakdownByRate,
  totalRemiseHt,
  lineTotalHt,
} = require("../utils/purchaseOrder");
const { resolvePurchaseOrderSites } = require("../utils/orderSites");
const { notifyCustomerOrderOutcome } = require("../utils/portalCustomerOrderNotify");
const { applyStockOnStatusTransitionTx, reserveStocksForOrderTx } = require("../utils/orderStock");

const router = express.Router();

function purchaseOrderContext(order) {
  const sortedLines = [...order.lines].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
  const lineRows = sortedLines.map((l) => ({
    productNameSnapshot: l.productNameSnapshot,
    productSkuSnapshot: l.productSkuSnapshot,
    quantity: Number(l.quantity),
    unitPriceHt: Number(l.unitPriceHt),
    discountPercent: Number(l.discountPercent),
    vatRate: Number(l.vatRate),
    lineHt: lineTotalHt(l),
  }));
  return {
    sortedLines,
    lineRows,
    vatRows: vatBreakdownByRate(sortedLines),
    remiseTotale: totalRemiseHt(sortedLines),
  };
}

async function createStatusHistory(tx, { orderId, organizationId, fromStatus, toStatus, changedById, comment }) {
  await tx.orderStatusHistory.create({ data: { orderId, organizationId, fromStatus, toStatus, changedById, comment: comment || null } });
}

router.get("/", async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const pageSize = 20;
  const statuses = req.query.statuses ? String(req.query.statuses).split(",").filter(Boolean) : [];
  const customerId = String(req.query.customerId || "");
  const fromDate = req.query.fromDate ? new Date(String(req.query.fromDate)) : null;
  const toDate = req.query.toDate ? new Date(String(req.query.toDate)) : null;
  const minAmount = req.query.minAmount ? Number(req.query.minAmount) : null;
  const maxAmount = req.query.maxAmount ? Number(req.query.maxAmount) : null;
  const q = String(req.query.q || "").trim();

  const where = {
    ...(statuses.length ? { status: { in: statuses } } : {}),
    ...(customerId ? { customerId } : {}),
    ...((fromDate || toDate)
      ? { createdAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } }
      : {}),
    ...((minAmount !== null || maxAmount !== null)
      ? { totalTtc: { ...(minAmount !== null ? { gte: minAmount } : {}), ...(maxAmount !== null ? { lte: maxAmount } : {}) } }
      : {}),
    ...(q ? { OR: [{ number: { contains: q } }, { customer: { companyName: { contains: q } } }] } : {}),
  };

  const [orders, total, customers, footer] = await Promise.all([
    prisma.order.findMany({ where, include: { customer: true }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.order.count({ where }),
    prisma.customer.findMany({ orderBy: { companyName: "asc" } }),
    prisma.order.aggregate({ where, _sum: { totalHt: true, totalTva: true, totalTtc: true } }),
  ]);

  const paginationParams = new URLSearchParams();
  if (q) paginationParams.set("q", q);
  if (customerId) paginationParams.set("customerId", customerId);
  if (req.query.fromDate) paginationParams.set("fromDate", String(req.query.fromDate));
  if (req.query.toDate) paginationParams.set("toDate", String(req.query.toDate));
  if (req.query.minAmount) paginationParams.set("minAmount", String(req.query.minAmount));
  if (req.query.maxAmount) paginationParams.set("maxAmount", String(req.query.maxAmount));
  statuses.forEach((s) => paginationParams.append("statuses", s));

  function pageHref(num) {
    const p = new URLSearchParams(paginationParams);
    p.set("page", String(num));
    const qs = p.toString();
    return qs ? `?${qs}` : `?page=${num}`;
  }

  function fmtMoney(v) {
    const n = Number(v || 0);
    return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  }
  const sum = footer._sum || {};
  return res.render("orders-list", {
    orders,
    customers,
    statuses: Object.values(STATUS),
    filters: { statuses, customerId, fromDate: req.query.fromDate || "", toDate: req.query.toDate || "", minAmount: req.query.minAmount || "", maxAmount: req.query.maxAmount || "", q },
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    footer: { totalHt: fmtMoney(sum.totalHt), totalTva: fmtMoney(sum.totalTva), totalTtc: fmtMoney(sum.totalTtc) },
    pageHref,
  });
});

router.get("/new", async (_req, res) => {
  const customers = await prisma.customer.findMany({ orderBy: { companyName: "asc" } });
  const products = await prisma.product.findMany({ orderBy: { name: "asc" } });
  return res.render("order-form", { customers, products, order: null });
});

router.get("/customer/:customerId/context", async (req, res) => {
  const [sites, customerPrices] = await Promise.all([
    prisma.customerSite.findMany({ where: { customerId: req.params.customerId }, orderBy: { isDefault: "desc" } }),
    prisma.customerPriceList.findMany({ where: { customerId: req.params.customerId } }),
  ]);
  return res.json({ sites, customerPrices });
});

router.post("/", async (req, res) => {
  const lines = JSON.parse(req.body.linesJson || "[]");
  if (!lines.length) return res.status(400).send("Au moins une ligne est requise.");
  const org = await prisma.organization.findUnique({ where: { id: req.user.organizationId } });
  const totals = computeOrderTotals(lines);
  const wantedStatus = req.body.actionType === "confirm" ? STATUS.CONFIRMED : STATUS.DRAFT;
  const status = wantedStatus === STATUS.CONFIRMED && totals.totalTtc > Number(org.approvalThresholdTtc) ? STATUS.PENDING_APPROVAL : wantedStatus;
  const number = await nextOrderNumber(prisma, req.user.organizationId);

  const created = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        number,
        customerId: req.body.customerId,
        deliverySiteId: req.body.deliverySiteId || null,
        billingSiteId: req.body.billingSiteId || null,
        status,
        totalHt: totals.totalHt,
        totalTva: totals.totalTva,
        totalTtc: totals.totalTtc,
        notes: req.body.notes || null,
        internalNotes: req.body.internalNotes || null,
        requestedDeliveryDate: req.body.requestedDeliveryDate ? new Date(req.body.requestedDeliveryDate) : null,
        createdById: req.user.sub,
      },
    });
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const lineTotals = computeOrderTotals([l]);
      await tx.orderLine.create({
        data: {
          orderId: order.id,
          productId: l.productId || null,
          productNameSnapshot: l.productNameSnapshot,
          productSkuSnapshot: l.productSkuSnapshot,
          quantity: Number(l.quantity || 0),
          unitPriceHt: Number(l.unitPriceHt || 0),
          discountPercent: Number(l.discountPercent || 0),
          vatRate: Number(l.vatRate || 0),
          lineTotalHt: lineTotals.totalHt,
          lineTotalTtc: lineTotals.totalTtc,
          sortOrder: i + 1,
        },
      });
    }
    await createStatusHistory(tx, {
      orderId: order.id,
      organizationId: req.user.organizationId,
      fromStatus: null,
      toStatus: status,
      changedById: req.user.sub,
      comment: "Creation commande",
    });
    if (status === STATUS.CONFIRMED) {
      await reserveStocksForOrderTx(tx, order.id, req.user.organizationId);
    }
    return order;
  });

  await notifyUsersByRoles({
    organizationId: req.user.organizationId,
    roles: ["MANAGER", "ADMIN", "OWNER"],
    type: TYPE.ORDER_RECEIVED,
    title: "Nouvelle commande",
    message: `Commande ${created.number} recue.`,
    link: `/dashboard/orders/${created.id}`,
  });
  if (status === STATUS.PENDING_APPROVAL) {
    await notifyUsersByRoles({
      organizationId: req.user.organizationId,
      roles: ["MANAGER", "ADMIN", "OWNER"],
      type: TYPE.APPROVAL_NEEDED,
      title: "Approbation requise",
      message: `Commande ${created.number} en attente d'approbation.`,
      link: `/dashboard/orders/${created.id}`,
    });
  }

  return res.redirect(`/dashboard/orders/${created.id}`);
});

router.get("/:id", async (req, res, next) => {
  if (req.params.id === "new") return next();
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      customer: { include: { sites: { orderBy: [{ isDefault: "desc" }, { label: "asc" }] } } },
      deliverySite: true,
      billingSite: true,
      lines: true,
      statusHistory: { include: { changedBy: true }, orderBy: { createdAt: "asc" } },
      approvedBy: true,
    },
  });
  if (!order) return res.status(404).send("Commande introuvable");
  const organization = await prisma.organization.findUnique({ where: { id: order.organizationId } });
  if (!organization) return res.status(404).send("Organisation introuvable");
  const { billingSite, deliverySite } = resolvePurchaseOrderSites(order);
  const { lineRows, vatRows, remiseTotale } = purchaseOrderContext(order);
  return res.render("order-detail", {
    order,
    organization,
    deliverySite,
    billingSite,
    lineRows,
    vatRows,
    remiseTotale,
    actions: availableActions(order, req.user.role),
    statusValues: Object.values(STATUS),
  });
});

router.post("/:id/status", async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).send("Commande introuvable");
  const toStatus = req.body.toStatus;
  if (!canStatusTransition({ from: order.status, to: toStatus, role: req.user.role })) return res.status(403).send("Transition non autorisee");
  if (toStatus === STATUS.CANCELLED && !req.body.comment) return res.status(400).send("Motif obligatoire");

  const fromStatus = order.status;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: toStatus,
          approvedById: toStatus === STATUS.CONFIRMED ? req.user.sub : order.approvedById,
          approvedAt: toStatus === STATUS.CONFIRMED ? new Date() : order.approvedAt,
          cancellationReason: toStatus === STATUS.CANCELLED ? req.body.comment : order.cancellationReason,
        },
      });
      await createStatusHistory(tx, {
        orderId: order.id,
        organizationId: req.user.organizationId,
        fromStatus,
        toStatus,
        changedById: req.user.sub,
        comment: req.body.comment || null,
      });
      await applyStockOnStatusTransitionTx(tx, {
        organizationId: req.user.organizationId,
        orderId: order.id,
        fromStatus,
        toStatus,
      });
    });
  } catch (e) {
    const msg = e?.message || String(e);
    if (/Stock insuffisant/i.test(msg)) {
      return res.status(400).send(msg);
    }
    throw e;
  }

  await notifyCustomerOrderOutcome(prisma, {
    orderId: order.id,
    fromStatus,
    toStatus,
    cancelComment: toStatus === STATUS.CANCELLED ? String(req.body.comment || "").trim() : null,
  });

  if (toStatus === STATUS.CONFIRMED && order.createdById !== req.user.sub) {
    await notifyUser({
      userId: order.createdById,
      organizationId: req.user.organizationId,
      type: TYPE.ORDER_APPROVED,
      title: "Commande approuvee",
      message: `Votre commande ${order.number} a ete approuvee.`,
      link: `/dashboard/orders/${order.id}`,
    });
  }
  return res.redirect(`/dashboard/orders/${order.id}`);
});

router.post("/:id/delete", async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order || order.status !== STATUS.DRAFT) return res.status(400).send("Suppression autorisee uniquement pour brouillon");
  await prisma.order.delete({ where: { id: order.id } });
  return res.redirect("/dashboard/orders");
});

router.post("/:id/duplicate", async (req, res) => {
  const source = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!source) return res.status(404).send("Commande introuvable");
  const number = await nextOrderNumber(prisma, req.user.organizationId);
  const created = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        number,
        customerId: source.customerId,
        deliverySiteId: source.deliverySiteId,
        billingSiteId: source.billingSiteId,
        status: STATUS.DRAFT,
        totalHt: source.totalHt,
        totalTva: source.totalTva,
        totalTtc: source.totalTtc,
        notes: source.notes,
        internalNotes: source.internalNotes,
        requestedDeliveryDate: source.requestedDeliveryDate,
        createdById: req.user.sub,
      },
    });
    for (const l of source.lines) {
      await tx.orderLine.create({
        data: {
          orderId: order.id,
          productId: l.productId,
          productNameSnapshot: l.productNameSnapshot,
          productSkuSnapshot: l.productSkuSnapshot,
          quantity: l.quantity,
          unitPriceHt: l.unitPriceHt,
          discountPercent: l.discountPercent,
          vatRate: l.vatRate,
          lineTotalHt: l.lineTotalHt,
          lineTotalTtc: l.lineTotalTtc,
          sortOrder: l.sortOrder,
        },
      });
    }
    await createStatusHistory(tx, {
      orderId: order.id,
      organizationId: req.user.organizationId,
      fromStatus: null,
      toStatus: STATUS.DRAFT,
      changedById: req.user.sub,
      comment: `Dupliquee depuis ${source.number}`,
    });
    return order;
  });
  return res.redirect(`/dashboard/orders/${created.id}`);
});

router.get("/:id/pdf", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      customer: { include: { sites: { orderBy: [{ isDefault: "desc" }, { label: "asc" }] } } },
      deliverySite: true,
      billingSite: true,
      lines: true,
    },
  });
  if (!order) return res.status(404).send("Commande introuvable");
  const organization = await prisma.organization.findUnique({ where: { id: order.organizationId } });
  if (!organization) return res.status(404).send("Organisation introuvable");
  const { billingSite, deliverySite } = resolvePurchaseOrderSites(order);
  const { sortedLines } = purchaseOrderContext(order);
  const orderForPdf = { ...order, lines: sortedLines };
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${order.number.replace(/[^\w.-]+/g, "_")}.pdf"`);
  pipePurchaseOrderPdf(res, {
    order: orderForPdf,
    organization,
    deliverySite,
    billingSite,
  });
});

router.post("/:id/generate-invoice", async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).send("Commande introuvable");
  if (order.status !== STATUS.DELIVERED || order.isInvoiced) return res.status(400).send("Facture non autorisee");
  return res.redirect(307, `/dashboard/invoices/from-order/${order.id}`);
});

router.get("/autocomplete/customers", async (req, res) => {
  const q = String(req.query.q || "");
  const rows = await prisma.customer.findMany({ where: { companyName: { contains: q } }, take: 10, orderBy: { companyName: "asc" } });
  res.json(rows);
});

router.get("/autocomplete/products", async (req, res) => {
  const q = String(req.query.q || "");
  const customerId = String(req.query.customerId || "");
  const rows = await prisma.product.findMany({
    where: { OR: [{ name: { contains: q } }, { sku: { contains: q } }] },
    take: 10,
    orderBy: { name: "asc" },
  });
  const data = [];
  for (const p of rows) {
    const imgs = (p.imageUrls || "").split("|").filter(Boolean);
    data.push({
      id: p.id,
      name: p.name,
      sku: p.sku,
      vatRate: p.vatRate,
      image: imgs[0] || null,
      price: customerId ? await getPriceForCustomer(p, customerId) : Number(p.basePriceHt),
    });
  }
  res.json(data);
});

module.exports = router;
