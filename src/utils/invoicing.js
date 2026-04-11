const path = require("node:path");
const fs = require("node:fs");
const PDFDocument = require("pdfkit");

const INVOICE_STATUS = {
  DRAFT: "DRAFT",
  SENT: "SENT",
  PAID: "PAID",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  OVERDUE: "OVERDUE",
  CANCELLED: "CANCELLED",
};

const INVOICE_TYPE = {
  INVOICE: "INVOICE",
  CREDIT_NOTE: "CREDIT_NOTE",
  PROFORMA: "PROFORMA",
};

const PAYMENT_METHODS = ["virement", "cheque", "carte", "especes", "autre"];

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function paymentDaysFromTerms(paymentTerms) {
  if (paymentTerms === "IMMEDIATE") return 0;
  if (paymentTerms === "NET_15") return 15;
  if (paymentTerms === "NET_30") return 30;
  if (paymentTerms === "NET_45") return 45;
  if (paymentTerms === "NET_60") return 60;
  return 30;
}

function computeInvoiceTotals(lines) {
  let totalHt = 0;
  let totalTtc = 0;
  const tvaByRate = {};
  for (const l of lines) {
    const qty = Number(l.quantity || 0);
    const unit = Number(l.unitPriceHt || 0);
    const discount = Number(l.discountPercent || 0) / 100;
    const vatRate = Number(l.vatRate || 0);
    const lineHt = qty * unit * (1 - discount);
    const lineTtc = lineHt * (1 + vatRate / 100);
    totalHt += lineHt;
    totalTtc += lineTtc;
    const key = String(vatRate);
    tvaByRate[key] = (tvaByRate[key] || 0) + (lineTtc - lineHt);
  }
  return { totalHt, totalTtc, totalTva: totalTtc - totalHt, tvaByRate };
}

function prefixForType(type) {
  if (type === INVOICE_TYPE.CREDIT_NOTE) return "AVR";
  if (type === INVOICE_TYPE.PROFORMA) return "PRF";
  return "FAC";
}

async function reserveInvoiceNumber(tx, organizationId, type, date = new Date()) {
  const year = date.getFullYear();
  const seq = await tx.invoiceSequence.upsert({
    where: { organizationId_year_type: { organizationId, year, type } },
    create: { organizationId, year, type, lastValue: 0 },
    update: {},
  });
  const nextVal = seq.lastValue + 1;
  await tx.invoiceSequence.update({
    where: { organizationId_year_type: { organizationId, year, type } },
    data: { lastValue: nextVal },
  });
  return `${prefixForType(type)}-${year}-${String(nextVal).padStart(4, "0")}`;
}

function generateInvoicePdfPath(orgId, invoiceNumber) {
  const dir = path.join(process.cwd(), "public", "invoices", orgId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${invoiceNumber}.pdf`);
}

async function createInvoicePdf({ invoice, organization, customer, lines, invoiceSite = null }) {
  if (!invoice.number) throw new Error("Numero de facture requis pour PDF");
  const filePath = generateInvoicePdfPath(organization.id, invoice.number);
  if (fs.existsSync(filePath)) return `/invoices/${organization.id}/${invoice.number}.pdf`;

  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  doc.fontSize(18).text(`Facture ${invoice.number}`);
  doc.moveDown();
  doc.fontSize(10).text(`${organization.name}`);
  doc.text(`${organization.address}`);
  doc.text(`SIRET: ${organization.siret}`);
  doc.text(`TVA: ${organization.vatNumber || "N/A"}`);
  doc.moveDown();
  doc.text(`Client: ${customer.companyName}`);
  if (invoiceSite?.label) {
    doc.text(`Site: ${invoiceSite.label}${invoiceSite.fullAddress ? ` - ${invoiceSite.fullAddress}` : ""}`);
  }
  doc.text(`Date emission: ${invoice.issuedAt?.toISOString().slice(0, 10) || "-"}`);
  doc.text(`Date echeance: ${invoice.dueAt?.toISOString().slice(0, 10) || "-"}`);
  doc.moveDown().text("Detail:");
  lines.forEach((l) => {
    doc.text(`${l.description} | qte ${l.quantity} | PU HT ${l.unitPriceHt} | TVA ${l.vatRate}% | TTC ${l.lineTotalTtc}`);
  });
  const totals = computeInvoiceTotals(lines);
  doc.moveDown().text(`Total HT: ${totals.totalHt.toFixed(2)} EUR`);
  Object.keys(totals.tvaByRate).forEach((rate) => doc.text(`TVA ${rate}%: ${totals.tvaByRate[rate].toFixed(2)} EUR`));
  doc.text(`Total TVA: ${totals.totalTva.toFixed(2)} EUR`);
  doc.text(`Total TTC: ${totals.totalTtc.toFixed(2)} EUR`);
  doc.moveDown().text(`Conditions de paiement: ${customer.paymentTerms}`);
  doc.text(organization.legalMentions || "Penalites de retard: taux legal. Indemnite forfaitaire de recouvrement: 40 EUR.");
  doc.end();

  await new Promise((resolve) => stream.on("finish", resolve));
  return `/invoices/${organization.id}/${invoice.number}.pdf`;
}

module.exports = {
  INVOICE_STATUS,
  INVOICE_TYPE,
  PAYMENT_METHODS,
  paymentDaysFromTerms,
  addDays,
  computeInvoiceTotals,
  reserveInvoiceNumber,
  createInvoicePdf,
};
