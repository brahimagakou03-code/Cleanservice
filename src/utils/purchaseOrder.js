const PDFDocument = require("pdfkit");

function formatMoney(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return "—";
  return `${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} €`;
}

function formatDate(d) {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function formatDateShort(d) {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("fr-FR");
}

/** Jusqu'à 3 points pour le pied de page (CGV / mentions). */
function legalNumberedParagraphs(text) {
  const raw = String(text || "").trim();
  let lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const defaults = [
    "Les prix sont indiqués hors taxes ; la TVA s'ajuste selon les taux en vigueur.",
    "Les délais et modalités de livraison sont celles convenues avec le vendeur.",
    "En cas de retard de paiement, pénalités et indemnité forfaitaire selon CGV et textes en vigueur.",
  ];
  if (lines.length === 0) lines = [...defaults];
  else if (lines.length === 1) lines = [lines[0], defaults[1], defaults[2]];
  while (lines.length < 3) lines.push(defaults[lines.length % defaults.length]);
  return lines.slice(0, 3);
}

/** Lignes de TVA par taux (montant TVA par taux). */
function vatBreakdownByRate(lines) {
  const map = {};
  for (const l of lines) {
    const rate = Number(l.vatRate || 0);
    const qty = Number(l.quantity || 0);
    const unit = Number(l.unitPriceHt || 0);
    const disc = Number(l.discountPercent || 0) / 100;
    const lineHt = qty * unit * (1 - disc);
    const vatAmt = lineHt * (rate / 100);
    map[rate] = (map[rate] || 0) + vatAmt;
  }
  return Object.keys(map)
    .map((k) => ({ rate: Number(k), amount: map[k] }))
    .sort((a, b) => a.rate - b.rate);
}

/** Montant HT « économisé » par les remises (% sur PU). */
function totalRemiseHt(lines) {
  let sum = 0;
  for (const l of lines) {
    const qty = Number(l.quantity || 0);
    const unit = Number(l.unitPriceHt || 0);
    const disc = Number(l.discountPercent || 0) / 100;
    if (disc > 0) sum += qty * unit * disc;
  }
  return sum;
}

/** Total HT d'une ligne (après remise %). */
function lineTotalHt(l) {
  const qty = Number(l.quantity || 0);
  const unit = Number(l.unitPriceHt || 0);
  const disc = Number(l.discountPercent || 0) / 100;
  return qty * unit * (1 - disc);
}

function paymentTermsLabel(terms) {
  const labels = {
    IMMEDIATE: "Comptant / immédiat",
    NET_15: "15 jours",
    NET_30: "30 jours",
    NET_45: "45 jours",
    NET_60: "60 jours",
  };
  return labels[terms] || terms || "Selon conditions convenues";
}

const ORDER_STATUS_FR = {
  DRAFT: "Brouillon",
  PENDING_APPROVAL: "En attente d'approbation",
  CONFIRMED: "Confirmée",
  IN_PREPARATION: "En préparation",
  SHIPPED: "Expédiée",
  DELIVERED: "Livrée",
  CANCELLED: "Annulée",
};

const BC_BLUE = "#003399";

/**
 * PDF bon de commande — mise en page type formulaire professionnel (en-tête, tableaux bleu roi).
 */
function pipePurchaseOrderPdf(res, { order, organization, deliverySite, billingSite }) {
  const doc = new PDFDocument({
    margin: 36,
    size: "A4",
    info: { Title: `Bon de commande ${order.number}`, Author: organization.name },
  });
  doc.pipe(res);

  const m = 36;
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const contentW = pageW - 2 * m;
  let y = m;

  const drawLinesHeader = (yy) => {
    const wQty = 38;
    const wUnit = 40;
    const wPu = 64;
    const wTot = 64;
    const wDesc = contentW - wQty - wUnit - wPu - wTot;
    const headers = ["QTÉ", "UNITÉ", "DESCRIPTION", "PRIX UNITAIRE", "TOTAL"];
    const widths = [wQty, wUnit, wDesc, wPu, wTot];
    let x = m;
    headers.forEach((h, i) => {
      const cw = widths[i];
      doc.save();
      doc.rect(x, yy, cw, 18).fill(BC_BLUE);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(6.5);
      const right = i === 0 || i === 3 || i === 4;
      doc.text(h, x + (right ? 2 : 3), yy + 5, { width: cw - 5, align: right ? "right" : "left" });
      doc.restore();
      x += cw;
    });
    return { wQty, wUnit, wDesc, wPu, wTot, headerBottom: yy + 18 };
  };

  /* ----- En-tête ----- */
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#000000");
  const leftW = contentW * 0.55;
  const orgBlock = organization.name.toUpperCase();
  const hOrg = doc.heightOfString(orgBlock, { width: leftW });
  doc.text(orgBlock, m, y, { width: leftW });

  const titleW = 160;
  doc.fontSize(13).fillColor("#555555");
  doc.text("BON DE COMMANDE", pageW - m - titleW, y, { width: titleW, align: "right" });
  doc.fillColor("#000000");

  y += Math.max(hOrg, 18) + 6;
  doc.font("Helvetica").fontSize(8);
  doc.text(
    `${organization.address}\nTél. : ${organization.phone} — E-mail : ${organization.email}`,
    m,
    y,
    { width: contentW * 0.7 },
  );
  y = doc.y + 2;
  doc.fontSize(7).fillColor("#444444");
  doc.text(
    `SIRET ${organization.siret}${organization.vatNumber ? ` — TVA ${organization.vatNumber}` : ""}`,
    m,
    y,
    { width: contentW },
  );
  doc.fillColor("#000000");
  y = doc.y + 10;

  doc.font("Helvetica-Oblique").fontSize(7);
  doc.text(
    "Les références ci-dessous doivent figurer sur toutes les correspondances, bons de livraison et factures relatives à la commande.",
    m,
    y,
    { width: contentW },
  );
  y = doc.y + 6;
  doc.font("Helvetica").fontSize(9);
  doc.text(`B.C. N° : ${order.number}`, m, y);
  y = doc.y + 12;

  /* ----- Deux colonnes client / livraison (données client + sites fiche) ----- */
  const gap = 8;
  const colW = (contentW - gap) / 2;
  const billingTxt = billingSite ? `${billingSite.label} — ${billingSite.fullAddress}` : "—";
  const sameBillDel = billingSite && deliverySite && billingSite.id === deliverySite.id;
  const deliveryTxt = deliverySite
    ? (sameBillDel ? "Idem adresse de facturation (ci-contre)" : `${deliverySite.label} — ${deliverySite.fullAddress}`)
    : billingSite
      ? "Idem adresse de facturation (ci-contre)"
      : "—";

  let leftClient = `${order.customer.companyName}\nN° client : ${order.customer.code}`;
  if (order.customer.siret) leftClient += `\nSIRET ${order.customer.siret}`;
  if (order.customer.vatNumber) leftClient += `\nTVA intracom. : ${order.customer.vatNumber}`;
  leftClient += `\n${billingTxt}`;
  if (order.customer.phone) leftClient += `\nTél. : ${order.customer.phone}`;
  if (order.customer.email) leftClient += `\nE-mail : ${order.customer.email}`;
  if (billingSite?.contactName || billingSite?.contactPhone || billingSite?.contactEmail) {
    leftClient += "\nContact site : ";
    leftClient += [billingSite.contactName, billingSite.contactPhone, billingSite.contactEmail].filter(Boolean).join(" — ");
  }

  let rightDel = deliveryTxt;
  if (deliverySite && !sameBillDel && (deliverySite.contactName || deliverySite.contactPhone || deliverySite.contactEmail)) {
    rightDel += `\nContact : ${[deliverySite.contactName, deliverySite.contactPhone, deliverySite.contactEmail].filter(Boolean).join(" — ")}`;
  }

  doc.font("Helvetica").fontSize(7.5);
  const hLeft = doc.heightOfString(leftClient, { width: colW - 8 });
  const hRight = doc.heightOfString(rightDel, { width: colW - 8 });
  const boxH = Math.max(72, Math.max(hLeft, hRight) + 22);

  doc.rect(m, y, colW, boxH).stroke();
  doc.rect(m + colW + gap, y, colW, boxH).stroke();
  doc.font("Helvetica-Bold").fontSize(8);
  doc.text("À :", m + 4, y + 4);
  doc.text("Adresse de livraison :", m + colW + gap + 4, y + 4);
  doc.font("Helvetica").fontSize(7.5);
  doc.text(leftClient, m + 4, y + 16, { width: colW - 8 });
  doc.text(rightDel, m + colW + gap + 4, y + 16, { width: colW - 8 });
  y += boxH + 10;

  /* ----- Tableau métadonnées ----- */
  const w5 = contentW / 5;
  const metaHeaders = ["DATE B.C.", "RECEVEUR", "TRANSIT", "POINT F.O.B.", "MODALITÉS"];
  let x = m;
  metaHeaders.forEach((label) => {
    doc.save();
    doc.rect(x, y, w5, 20).fill(BC_BLUE);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(6);
    doc.text(label, x + 3, y + 6, { width: w5 - 6 });
    doc.restore();
    x += w5;
  });
  y += 20;
  const metaVals = [
    formatDateShort(order.createdAt),
    order.customer.companyName,
    "—",
    "Départ entrepôt",
    paymentTermsLabel(order.customer.paymentTerms),
  ];
  x = m;
  metaVals.forEach((val) => {
    doc.rect(x, y, w5, 20).stroke();
    doc.font("Helvetica").fontSize(7).fillColor("#000000");
    doc.text(String(val), x + 3, y + 5, { width: w5 - 6 });
    x += w5;
  });
  y += 24;

  /* ----- Lignes produits ----- */
  const footerReserve = 130;
  let lineLayout = drawLinesHeader(y);
  y = lineLayout.headerBottom;

  const drawProductRow = (desc, qty, unitPrice, lineHt, rowH) => {
    const { wQty, wUnit, wDesc, wPu, wTot } = lineLayout;
    let xc = m;
    doc.rect(xc, y, wQty, rowH).stroke();
    doc.font("Helvetica").fontSize(7).text(String(qty), xc + 2, y + 4, { width: wQty - 4, align: "right" });
    xc += wQty;
    doc.rect(xc, y, wUnit, rowH).stroke();
    doc.text(unitPrice === null ? "" : "pce", xc + 3, y + 4, { width: wUnit - 6 });
    xc += wUnit;
    doc.rect(xc, y, wDesc, rowH).stroke();
    if (desc) doc.text(desc, xc + 3, y + 4, { width: wDesc - 6 });
    xc += wDesc;
    doc.rect(xc, y, wPu, rowH).stroke();
    if (unitPrice !== null) doc.text(formatMoney(unitPrice), xc + 2, y + 4, { width: wPu - 4, align: "right" });
    xc += wPu;
    doc.rect(xc, y, wTot, rowH).stroke();
    if (lineHt !== null) doc.text(formatMoney(lineHt), xc + 2, y + 4, { width: wTot - 4, align: "right" });
  };

  for (const l of order.lines) {
    const disc = Number(l.discountPercent || 0);
    let desc = l.productNameSnapshot;
    if (l.productSkuSnapshot) desc += `\nRéf. ${l.productSkuSnapshot}`;
    if (disc > 0) desc += `\nRemise ${disc} %`;
    doc.font("Helvetica").fontSize(7);
    const rowH = Math.max(20, doc.heightOfString(desc, { width: lineLayout.wDesc - 6 }) + 10);
    if (y + rowH > pageH - footerReserve) {
      doc.addPage();
      y = m;
      lineLayout = drawLinesHeader(y);
      y = lineLayout.headerBottom;
    }
    drawProductRow(desc, l.quantity, l.unitPriceHt, lineTotalHt(l), rowH);
    y += rowH;
  }

  const fillerCount = Math.max(0, Math.min(10, 8 - order.lines.length));
  for (let i = 0; i < fillerCount; i++) {
    if (y + 22 > pageH - footerReserve) {
      doc.addPage();
      y = m;
      lineLayout = drawLinesHeader(y);
      y = lineLayout.headerBottom;
    }
    drawProductRow("", "", null, null, 20);
    y += 20;
  }

  y += 8;

  /* ----- Totaux à droite ----- */
  if (y + 80 > pageH - footerReserve) {
    doc.addPage();
    y = m;
  }
  const totW = 210;
  const labelW = totW - 78;
  const valW = 78;
  const totX = pageW - m - totW;
  const rows = [
    ["SOUS-TOTAL", formatMoney(order.totalHt), false],
    ["TAXE (TVA)", formatMoney(order.totalTva), false],
    ["TRANSP. & MANUTENTION", formatMoney(0), false],
    ["TOTAL", formatMoney(order.totalTtc), true],
  ];
  rows.forEach(([lab, val, bold]) => {
    doc.rect(totX, y, labelW, 17).stroke();
    doc.rect(totX + labelW, y, valW, 17).stroke();
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    doc.text(lab, totX + 4, y + 4, { width: labelW - 8, align: "right" });
    doc.text(val, totX + labelW + 4, y + 4, { width: valW - 8, align: "right" });
    y += 17;
  });

  y += 14;

  /* ----- Pied : mentions + signature ----- */
  if (y > pageH - footerReserve) {
    doc.addPage();
    y = m;
  }
  const legals = legalNumberedParagraphs(organization.legalMentions);
  const footW = contentW * 0.5;
  let yL = y;
  legals.forEach((line, i) => {
    doc.font("Helvetica").fontSize(7);
    doc.text(`${i + 1}. ${line}`, m, yL, { width: footW });
    yL = doc.y + 3;
  });
  doc.fontSize(6).fillColor("#444444");
  doc.text(
    `Livraison souhaitée : ${order.requestedDeliveryDate ? formatDate(order.requestedDeliveryDate) : "À convenir"} — Statut : ${ORDER_STATUS_FR[order.status] || order.status}`,
    m,
    yL,
    { width: footW },
  );
  doc.fillColor("#000000");

  const signX = m + footW + 12;
  let yS = y;
  doc.font("Helvetica").fontSize(8);
  doc.text("Autorisé par : ________________     Titre : ________________", signX, yS, { width: contentW - footW - 12 });
  yS = doc.y + 12;
  doc.moveTo(signX, yS).lineTo(pageW - m, yS).stroke();
  yS += 8;
  doc.fontSize(7);
  doc.text("Signature", signX, yS, { width: 100 });
  doc.text("Date", pageW - m - 70, yS, { width: 70, align: "right" });
  yS += 14;
  doc.fontSize(6).fillColor("#666666");
  doc.text("Bon pour accord.", signX, yS);
  doc.fillColor("#000000");

  doc.end();
}

module.exports = {
  formatMoney,
  formatDate,
  vatBreakdownByRate,
  totalRemiseHt,
  lineTotalHt,
  paymentTermsLabel,
  pipePurchaseOrderPdf,
};
