const express = require("express");
const { prisma } = require("../db");
const {
  INVOICE_STATUS,
  INVOICE_TYPE,
  PAYMENT_METHODS,
  paymentDaysFromTerms,
  addDays,
  computeInvoiceTotals,
  reserveInvoiceNumber,
  createInvoicePdf,
} = require("../utils/invoicing");
const { TYPE, notifyUser, notifyUsersByRoles } = require("../utils/notifications");
const { enqueueEmail } = require("../utils/emailQueue");
const { invoiceSendTemplate } = require("../utils/emailTemplates");
const { STATUS: ORDER_STATUS } = require("../utils/orders");

const router = express.Router();
const CUSTOMER_SAFE_SELECT = {
  id: true,
  code: true,
  companyName: true,
  countryCode: true,
  siret: true,
  vatNumber: true,
  email: true,
  phone: true,
  website: true,
  notes: true,
  paymentTerms: true,
  isActive: true,
  portalPasswordHash: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
};
const ELIGIBLE_ORDER_STATUSES_FOR_INVOICE = [
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.IN_PREPARATION,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.DELIVERED,
];

const SITE_MARKER = "__INVOICE_SITE__:";

function stripSiteMetadata(notes) {
  const text = String(notes || "");
  const lines = text.split("\n");
  if (!lines.length) return "";
  if (lines[0].startsWith(SITE_MARKER)) return lines.slice(1).join("\n").trim();
  return text.trim();
}

function readSiteMetadata(notes) {
  const text = String(notes || "");
  const firstLine = text.split("\n")[0] || "";
  if (!firstLine.startsWith(SITE_MARKER)) return null;
  try {
    const payload = JSON.parse(firstLine.slice(SITE_MARKER.length));
    if (!payload || !payload.id) return null;
    return {
      id: payload.id,
      label: payload.label || "",
      fullAddress: payload.fullAddress || "",
    };
  } catch {
    return null;
  }
}

function composeNotesWithSite(rawNotes, site) {
  const cleanNotes = stripSiteMetadata(rawNotes);
  if (!site) return cleanNotes;
  const meta = JSON.stringify({ id: site.id, label: site.label || "", fullAddress: site.fullAddress || "" });
  return `${SITE_MARKER}${meta}${cleanNotes ? `\n${cleanNotes}` : ""}`;
}

async function resolveSiteForCustomer(customerId, siteId) {
  if (!customerId || !siteId) return null;
  return prisma.customerSite.findFirst({
    where: { id: siteId, customerId },
    select: { id: true, label: true, fullAddress: true },
  });
}

async function recomputePaymentStatus(invoiceId) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true } });
  const paid = invoice.payments.reduce((acc, p) => acc + Number(p.amount), 0);
  let status = invoice.status;
  if (paid <= 0 && [INVOICE_STATUS.PAID, INVOICE_STATUS.PARTIALLY_PAID].includes(status)) status = INVOICE_STATUS.SENT;
  if (paid > 0 && paid < Number(invoice.totalTtc)) status = INVOICE_STATUS.PARTIALLY_PAID;
  if (paid >= Number(invoice.totalTtc)) status = INVOICE_STATUS.PAID;
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid: paid, amountDue: Number(invoice.totalTtc) - paid, status, paidAt: status === INVOICE_STATUS.PAID ? new Date() : null },
  });
}

router.get("/", async (req, res) => {
  const q = String(req.query.q || "");
  const status = String(req.query.status || "");
  const type = String(req.query.type || "");
  const customerId = String(req.query.customerId || "");
  const fromDate = req.query.fromDate ? new Date(String(req.query.fromDate)) : null;
  const toDate = req.query.toDate ? new Date(String(req.query.toDate)) : null;

  const where = {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(customerId ? { customerId } : {}),
    ...(q ? { OR: [{ number: { contains: q } }, { customer: { companyName: { contains: q } } }] } : {}),
    ...((fromDate || toDate) ? { issuedAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } } : {}),
  };
  const startMonth = new Date();
  startMonth.setDate(1);
  startMonth.setHours(0, 0, 0, 0);
  const [items, customers, totalInvoiced, totalPaid, totalOverdue] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: { customer: { select: { id: true, companyName: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.customer.findMany({ select: { id: true, companyName: true }, orderBy: { companyName: "asc" } }),
    prisma.invoice.aggregate({ where: { issuedAt: { gte: startMonth }, type: INVOICE_TYPE.INVOICE }, _sum: { totalTtc: true } }),
    prisma.payment.aggregate({ _sum: { amount: true } }),
    prisma.invoice.aggregate({ where: { status: INVOICE_STATUS.OVERDUE }, _sum: { amountDue: true } }),
  ]);
  return res.render("invoices-list", {
    invoices: items,
    customers,
    filters: { q, status, type, customerId, fromDate: req.query.fromDate || "", toDate: req.query.toDate || "" },
    statusValues: Object.values(INVOICE_STATUS),
    typeValues: Object.values(INVOICE_TYPE),
    indicators: {
      invoicedMonth: totalInvoiced._sum.totalTtc || 0,
      paidTotal: totalPaid._sum.amount || 0,
      overdueTotal: totalOverdue._sum.amountDue || 0,
    },
  });
});

router.get("/new", async (req, res) => {
  const customers = await prisma.customer.findMany({
    where: { organizationId: req.user.organizationId },
    orderBy: { companyName: "asc" },
    select: {
      ...CUSTOMER_SAFE_SELECT,
      sites: { orderBy: [{ isDefault: "desc" }, { label: "asc" }] },
    },
  });
  const eligibleOrders = await prisma.order.findMany({
    where: {
      organizationId: req.user.organizationId,
      status: { in: ELIGIBLE_ORDER_STATUSES_FOR_INVOICE },
      isInvoiced: false,
    },
    select: {
      id: true,
      number: true,
      customerId: true,
      status: true,
      totalTtc: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return res.render("invoice-form", { invoice: null, customers, eligibleOrders, orderLines: [], paymentMethods: PAYMENT_METHODS });
});

router.post("/from-order/:orderId", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    include: { customer: { select: CUSTOMER_SAFE_SELECT }, lines: true, billingSite: true, deliverySite: true },
  });
  if (!order) return res.status(404).send("Commande introuvable");
  if (order.organizationId !== req.user.organizationId) return res.status(403).send("Acces refuse");
  if (!ELIGIBLE_ORDER_STATUSES_FOR_INVOICE.includes(order.status) || order.isInvoiced) {
    return res.status(400).send("Seules les commandes validees non deja facturees sont autorisees");
  }
  const dueAt = addDays(new Date(), paymentDaysFromTerms(order.customer.paymentTerms));
  const linesPayload = order.lines.map((l) => ({
    description: `${l.productSkuSnapshot} - ${l.productNameSnapshot}`,
    quantity: Number(l.quantity),
    unitPriceHt: Number(l.unitPriceHt),
    vatRate: Number(l.vatRate),
    discountPercent: Number(l.discountPercent),
  }));
  const totals = computeInvoiceTotals(linesPayload);
  const orderSite = order.billingSite || order.deliverySite || null;
  const invoice = await prisma.invoice.create({
    data: {
      orderId: order.id,
      customerId: order.customerId,
      type: INVOICE_TYPE.INVOICE,
      status: INVOICE_STATUS.DRAFT,
      dueAt,
      totalHt: totals.totalHt,
      totalTva: totals.totalTva,
      totalTtc: totals.totalTtc,
      amountDue: totals.totalTtc,
      notes: composeNotesWithSite(order.notes || "", orderSite),
    },
  });
  for (let i = 0; i < linesPayload.length; i++) {
    const l = linesPayload[i];
    const lineTotals = computeInvoiceTotals([l]);
    await prisma.invoiceLine.create({
      data: {
        invoiceId: invoice.id,
        description: l.description,
        quantity: l.quantity,
        unitPriceHt: l.unitPriceHt,
        vatRate: l.vatRate,
        discountPercent: l.discountPercent,
        lineTotalHt: lineTotals.totalHt,
        lineTotalTtc: lineTotals.totalTtc,
        sortOrder: i + 1,
      },
    });
  }
  await prisma.order.update({ where: { id: order.id }, data: { isInvoiced: true } });
  return res.redirect(`/dashboard/invoices/${invoice.id}`);
});

router.post("/", async (req, res) => {
  const lines = JSON.parse(req.body.linesJson || "[]");
  if (!lines.length) return res.status(400).send("Au moins une ligne requise");
  const customer = await prisma.customer.findUnique({ where: { id: req.body.customerId }, select: CUSTOMER_SAFE_SELECT });
  if (!customer) return res.status(400).send("Client introuvable");
  const selectedSite = await resolveSiteForCustomer(req.body.customerId, req.body.customerSiteId);
  const notesWithSite = composeNotesWithSite(req.body.notes || "", selectedSite);
  const dueAt = addDays(new Date(), paymentDaysFromTerms(customer.paymentTerms));
  const totals = computeInvoiceTotals(lines);
  const invoice = await prisma.invoice.create({
    data: {
      customerId: req.body.customerId,
      type: req.body.type || INVOICE_TYPE.INVOICE,
      status: INVOICE_STATUS.DRAFT,
      dueAt,
      totalHt: totals.totalHt,
      totalTva: totals.totalTva,
      totalTtc: totals.totalTtc,
      amountDue: totals.totalTtc,
      notes: notesWithSite || null,
    },
  });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const lineTotals = computeInvoiceTotals([l]);
    await prisma.invoiceLine.create({
      data: {
        invoiceId: invoice.id,
        description: l.description,
        quantity: Number(l.quantity),
        unitPriceHt: Number(l.unitPriceHt),
        vatRate: Number(l.vatRate),
        discountPercent: Number(l.discountPercent || 0),
        lineTotalHt: lineTotals.totalHt,
        lineTotalTtc: lineTotals.totalTtc,
        sortOrder: i + 1,
      },
    });
  }
  return res.redirect(`/dashboard/invoices/${invoice.id}`);
});

router.get("/:id", async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: {
      customer: { select: CUSTOMER_SAFE_SELECT },
      lines: true,
      payments: { orderBy: { paidAt: "desc" } },
      originalInvoice: true,
    },
  });
  if (!invoice) return res.status(404).send("Facture introuvable");
  const customers = await prisma.customer.findMany({
    orderBy: { companyName: "asc" },
    select: {
      ...CUSTOMER_SAFE_SELECT,
      sites: { orderBy: [{ isDefault: "desc" }, { label: "asc" }] },
    },
  });
  const invoiceSite = readSiteMetadata(invoice.notes);
  const invoiceForView = { ...invoice, notes: stripSiteMetadata(invoice.notes) };
  return res.render("invoice-form", {
    invoice: invoiceForView,
    invoiceSite,
    customers,
    orderLines: [],
    paymentMethods: PAYMENT_METHODS,
  });
});

router.post("/:id/update", async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).send("Facture introuvable");
  if (invoice.status !== INVOICE_STATUS.DRAFT) return res.status(400).send("Seul un brouillon peut etre modifie");

  const customer = await prisma.customer.findUnique({ where: { id: req.body.customerId }, select: CUSTOMER_SAFE_SELECT });
  if (!customer) return res.status(400).send("Client introuvable");
  const selectedSite = await resolveSiteForCustomer(req.body.customerId, req.body.customerSiteId);
  const notesWithSite = composeNotesWithSite(req.body.notes || "", selectedSite);
  const dueAt = addDays(new Date(), paymentDaysFromTerms(customer.paymentTerms));

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      customerId: customer.id,
      type: req.body.type || invoice.type,
      dueAt,
      notes: notesWithSite || null,
    },
  });
  return res.redirect(`/dashboard/invoices/${invoice.id}`);
});

router.post("/:id/finalize", async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: { lines: true, customer: { select: CUSTOMER_SAFE_SELECT } },
  });
  if (!invoice) return res.status(404).send("Facture introuvable");
  if (invoice.status !== INVOICE_STATUS.DRAFT) return res.status(400).send("Seul un brouillon peut etre finalise");
  const org = await prisma.organization.findUnique({ where: { id: req.user.organizationId } });
  const result = await prisma.$transaction(async (tx) => {
    const number = await reserveInvoiceNumber(tx, req.user.organizationId, invoice.type, new Date());
    const issuedAt = new Date();
    const dueAt = addDays(issuedAt, paymentDaysFromTerms(invoice.customer.paymentTerms));
    await tx.invoice.updateMany({
      where: { id: invoice.id },
      data: { number, status: INVOICE_STATUS.SENT, issuedAt, dueAt, legalMentions: org.legalMentions || invoice.legalMentions, sentAt: null },
    });
    return tx.invoice.findFirst({
      where: { id: invoice.id },
      include: { lines: true, customer: { select: CUSTOMER_SAFE_SELECT } },
    });
  });
  if (!result?.customer || !result.lines) {
    return res.status(500).send("Mise à jour facture impossible.");
  }
  const site = readSiteMetadata(result.notes);
  const pdfUrl = await createInvoicePdf({
    invoice: result,
    organization: org,
    customer: result.customer,
    lines: result.lines,
    invoiceSite: site,
  });
  await prisma.invoice.update({ where: { id: result.id }, data: { pdfUrl } });
  return res.redirect(`/dashboard/invoices/${result.id}`);
});

router.post("/:id/delete", async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).send("Facture introuvable");
  if (invoice.status !== INVOICE_STATUS.DRAFT) return res.status(400).send("Une facture finalisee ne peut jamais etre supprimee");
  await prisma.invoice.delete({ where: { id: invoice.id } });
  return res.redirect("/dashboard/invoices");
});

router.post("/:id/send-email", async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: { customer: { select: CUSTOMER_SAFE_SELECT } },
  });
  if (!invoice || !invoice.number) return res.status(400).send("Facture non finalisee");
  await prisma.invoice.update({ where: { id: invoice.id }, data: { sentAt: new Date() } });
  const tpl = invoiceSendTemplate({
    invoiceNumber: invoice.number,
    amount: invoice.totalTtc,
    dueDate: invoice.dueAt ? invoice.dueAt.toISOString().slice(0, 10) : "-",
    pdfUrl: `${process.env.APP_BASE_URL || "http://127.0.0.1:3000"}${invoice.pdfUrl || ""}`,
  });
  await enqueueEmail({
    organizationId: invoice.organizationId,
    toEmail: invoice.customer.email || "",
    subject: tpl.subject,
    html: tpl.html,
  });
  return res.redirect(`/dashboard/invoices/${invoice.id}`);
});

router.post("/:id/payment", async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).send("Facture introuvable");
  if (![INVOICE_STATUS.SENT, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE].includes(invoice.status)) return res.status(400).send("Paiement impossible");
  await prisma.payment.create({
    data: {
      invoiceId: invoice.id,
      amount: Number(req.body.amount || 0),
      paidAt: req.body.paidAt ? new Date(req.body.paidAt) : new Date(),
      method: PAYMENT_METHODS.includes(req.body.method) ? req.body.method : "autre",
      reference: req.body.reference || null,
      notes: req.body.notes || null,
    },
  });
  await recomputePaymentStatus(invoice.id);
  const order = await prisma.order.findFirst({ where: { id: invoice.orderId || undefined } });
  if (order?.createdById) {
    await notifyUser({
      userId: order.createdById,
      organizationId: invoice.organizationId,
      type: TYPE.PAYMENT_RECEIVED,
      title: "Paiement recu",
      message: `Paiement enregistre sur la facture ${invoice.number || "(brouillon)"}.`,
      link: `/dashboard/invoices/${invoice.id}`,
    });
  } else {
    await notifyUsersByRoles({
      organizationId: invoice.organizationId,
      roles: ["ADMIN", "OWNER"],
      type: TYPE.PAYMENT_RECEIVED,
      title: "Paiement recu",
      message: `Paiement enregistre sur la facture ${invoice.number || "(brouillon)"}.`,
      link: `/dashboard/invoices/${invoice.id}`,
    });
  }
  return res.redirect(`/dashboard/invoices/${invoice.id}`);
});

router.post("/:id/create-credit-note", async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: { lines: true, customer: { select: CUSTOMER_SAFE_SELECT } },
  });
  if (!invoice || !invoice.number) return res.status(400).send("Facture source invalide");
  const created = await prisma.invoice.create({
    data: {
      originalInvoiceId: invoice.id,
      customerId: invoice.customerId,
      type: INVOICE_TYPE.CREDIT_NOTE,
      status: INVOICE_STATUS.DRAFT,
      notes: `Avoir base sur ${invoice.number}`,
    },
  });
  for (let i = 0; i < invoice.lines.length; i++) {
    const l = invoice.lines[i];
    await prisma.invoiceLine.create({
      data: {
        invoiceId: created.id,
        description: l.description,
        quantity: -Math.abs(Number(l.quantity)),
        unitPriceHt: Number(l.unitPriceHt),
        vatRate: Number(l.vatRate),
        discountPercent: Number(l.discountPercent),
        lineTotalHt: -Math.abs(Number(l.lineTotalHt)),
        lineTotalTtc: -Math.abs(Number(l.lineTotalTtc)),
        sortOrder: i + 1,
      },
    });
  }
  const totals = computeInvoiceTotals(invoice.lines.map((l) => ({
    quantity: -Math.abs(Number(l.quantity)),
    unitPriceHt: Number(l.unitPriceHt),
    vatRate: Number(l.vatRate),
    discountPercent: Number(l.discountPercent),
  })));
  await prisma.invoice.update({
    where: { id: created.id },
    data: { totalHt: totals.totalHt, totalTva: totals.totalTva, totalTtc: totals.totalTtc, amountDue: totals.totalTtc },
  });
  return res.redirect(`/dashboard/invoices/${created.id}`);
});

router.get("/:id/pdf", async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice?.pdfUrl) return res.status(400).send("PDF non disponible");
  return res.redirect(invoice.pdfUrl);
});

module.exports = router;
