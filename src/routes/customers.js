const crypto = require("node:crypto");
const express = require("express");
const { parse } = require("csv-parse/sync");
const XLSX = require("xlsx");
const { prisma } = require("../db");
const { can } = require("../utils/rbac");
const { customerSchema, PAYMENT_TERMS } = require("../utils/customerValidation");
const { enqueueEmail } = require("../utils/emailQueue");
const { clientPortalCredentialsTemplate } = require("../utils/emailTemplates");
const { hashPassword, generatePortalPassword } = require("../utils/auth");
const { ensureCustomerSupabaseAuthUser } = require("../utils/supabaseAuth");
const { ensureImportCsvFile } = require("../middleware/earlyMultipartBeforeCsrf");

const router = express.Router();

/** Jeton jetable → mot de passe portail affiché une fois après génération (pas en session). */
const portalCredentialsFlash = new Map();

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

function parseBool(value) {
  return value === "on" || value === "true" || value === true;
}

async function safeAttachCustomerAuthUid(customerId, authUid) {
  if (!customerId || !authUid) return;
  try {
    await prisma.customer.update({ where: { id: customerId }, data: { authUid } });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("Customer.authUid") && msg.includes("does not exist")) return;
    throw err;
  }
}

/** Chaque site client doit avoir organizationId (Prisma ne l'infère pas depuis le parent). */
function customerSitesCreateData(sites, organizationId) {
  return sites.map((s) => ({
    organizationId,
    label: s.label,
    fullAddress: s.fullAddress,
    isDefault: s.isDefault ?? false,
    isShipping: s.isShipping ?? true,
    isBilling: s.isBilling ?? false,
    contactName: s.contactName && String(s.contactName).trim() ? String(s.contactName).trim() : null,
    contactEmail: s.contactEmail && String(s.contactEmail).trim() ? String(s.contactEmail).trim() : null,
    contactPhone: s.contactPhone && String(s.contactPhone).trim() ? String(s.contactPhone).trim() : null,
  }));
}

function normalizeGeneralPayload(body) {
  return {
    companyName: body.companyName,
    countryCode: body.countryCode || "FR",
    siret: body.siret || "",
    vatNumber: body.vatNumber || "",
    email: body.email || "",
    phone: body.phone || "",
    website: body.website || "",
    notes: body.notes || "",
    paymentTerms: body.paymentTerms || "NET_30",
    isActive: parseBool(body.isActive),
  };
}

async function nextCustomerCode() {
  const last = await prisma.customer.findFirst({
    orderBy: { code: "desc" },
    select: { code: true },
  });
  const current = last?.code ? Number(last.code.split("-")[1]) : 0;
  return `CLI-${String(current + 1).padStart(4, "0")}`;
}

function parseSitesFromBody(body) {
  const asArr = (v) => (Array.isArray(v) ? v : v !== undefined && v !== null && v !== "" ? [v] : []);
  const labels = asArr(body.siteLabel);
  const addresses = asArr(body.siteAddress);
  const names = asArr(body.siteContactName);
  const emails = asArr(body.siteContactEmail);
  const phones = asArr(body.siteContactPhone);
  const n = Math.max(labels.length, addresses.length, names.length, emails.length, phones.length, 1);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const label = String(labels[i] ?? "").trim();
    const fullAddress = String(addresses[i] ?? "").trim();
    if (!label && !fullAddress) continue;
    if (!label || !fullAddress) {
      return {
        sites: [],
        error:
          "Chaque site renseigné doit avoir un libellé et une adresse complète. Complétez la ligne ou videz-la entièrement.",
      };
    }
    rows.push({
      label,
      fullAddress,
      contactName: String(names[i] ?? "").trim(),
      contactEmail: String(emails[i] ?? "").trim(),
      contactPhone: String(phones[i] ?? "").trim(),
      isDefault: false,
      isShipping: true,
      isBilling: false,
    });
  }
  if (rows.length) {
    rows[0].isDefault = true;
    rows[0].isBilling = true;
  }
  return { sites: rows, error: null };
}

router.get("/", async (req, res) => {
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*") || can(req.user.role, "read:all"))) {
    return res.status(403).send("Acces refuse");
  }
  const page = Math.max(Number(req.query.page || 1), 1);
  const pageSize = 10;
  const q = String(req.query.q || "").trim();
  const isActive = req.query.isActive;
  const paymentTerms = String(req.query.paymentTerms || "");
  const sortBy = ["code", "companyName", "email", "createdAt"].includes(req.query.sortBy) ? req.query.sortBy : "createdAt";
  const sortDir = req.query.sortDir === "asc" ? "asc" : "desc";

  const where = {
    ...(q
      ? {
          OR: [
            { companyName: { contains: q } },
            { code: { contains: q } },
            { email: { contains: q } },
          ],
        }
      : {}),
    ...(isActive === "active" ? { isActive: true } : {}),
    ...(isActive === "inactive" ? { isActive: false } : {}),
    ...(paymentTerms ? { paymentTerms } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      select: {
        id: true,
        code: true,
        companyName: true,
        email: true,
        paymentTerms: true,
        isActive: true,
        sites: { select: { id: true } },
      },
      orderBy: { [sortBy]: sortDir },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customer.count({ where }),
  ]);

  return res.render("customers-list", {
    customers: items,
    page,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
    filters: { q, isActive: isActive || "", paymentTerms, sortBy, sortDir },
    paymentTermsOptions: PAYMENT_TERMS,
    canDeleteCustomer: can(req.user.role, "clients:manage") || can(req.user.role, "*"),
  });
});

router.get("/new", (_req, res) => {
  return res.render("customer-form", { paymentTermsOptions: PAYMENT_TERMS, errors: [] });
});

router.post("/", async (req, res) => {
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*"))) {
    return res.status(403).send("Acces refuse");
  }
  const { sites: sitesFromForm, error: sitesParseError } = parseSitesFromBody(req.body);
  if (sitesParseError) {
    return res.status(400).render("customer-form", {
      paymentTermsOptions: PAYMENT_TERMS,
      errors: [sitesParseError],
    });
  }

  const payload = {
    companyName: req.body.companyName,
    countryCode: req.body.countryCode || "FR",
    siret: req.body.siret || "",
    vatNumber: req.body.vatNumber || "",
    email: req.body.email || "",
    phone: req.body.phone || "",
    website: req.body.website || "",
    notes: req.body.notes || "",
    paymentTerms: req.body.paymentTerms || "NET_30",
    isActive: parseBool(req.body.isActive),
    sites: sitesFromForm,
  };

  const parsed = customerSchema.safeParse(payload);
  if (!parsed.success) {
    return res.status(400).render("customer-form", {
      paymentTermsOptions: PAYMENT_TERMS,
      errors: parsed.error.issues.map((i) => i.message),
    });
  }

  const emailNorm =
    parsed.data.email && String(parsed.data.email).trim() ? String(parsed.data.email).trim().toLowerCase() : null;
  if (!emailNorm) {
    return res.status(400).render("customer-form", {
      paymentTermsOptions: PAYMENT_TERMS,
      errors: [
        "E-mail obligatoire : il sert d'identifiant sur le portail client et pour recevoir le mot de passe par e-mail.",
      ],
    });
  }

  const plainPortalPassword = generatePortalPassword();
  const portalPasswordHash = await hashPassword(plainPortalPassword);

  const code = await nextCustomerCode();
  const organizationId = req.user.organizationId;
  const customer = await prisma.customer.create({
    data: {
      code,
      companyName: parsed.data.companyName,
      countryCode: parsed.data.countryCode,
      siret: parsed.data.siret || null,
      vatNumber: parsed.data.vatNumber || null,
      email: emailNorm,
      phone: parsed.data.phone || null,
      website: parsed.data.website || null,
      notes: parsed.data.notes || null,
      paymentTerms: parsed.data.paymentTerms,
      isActive: parsed.data.isActive ?? true,
      portalPasswordHash,
      sites: { create: customerSitesCreateData(parsed.data.sites, organizationId) },
    },
  });

  const sup = await ensureCustomerSupabaseAuthUser(emailNorm, plainPortalPassword);
  if (sup.ok) await safeAttachCustomerAuthUid(customer.id, sup.authUid);

  const baseUrl = process.env.APP_BASE_URL || "http://127.0.0.1:3000";
  const tpl = clientPortalCredentialsTemplate({
    customerName: customer.companyName,
    loginUrl: `${baseUrl}/login`,
    identifier: emailNorm,
    plainPassword: plainPortalPassword,
    code: customer.code,
  });
  await enqueueEmail({
    organizationId,
    toEmail: emailNorm,
    subject: tpl.subject,
    html: tpl.html,
  });

  return res.redirect(`/dashboard/customers/${customer.id}`);
});

router.post("/:id/delete", async (req, res, next) => {
  if (["export", "import", "new"].includes(req.params.id)) {
    return next();
  }
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*"))) {
    return res.status(403).send("Acces refuse");
  }
  try {
    await prisma.customer.delete({ where: { id: req.params.id } });
  } catch (err) {
    return res.status(400).send(`Suppression impossible : ${err.message}`);
  }
  return res.redirect("/dashboard/customers");
});

router.get("/:id", async (req, res, next) => {
  if (["export", "import", "new"].includes(req.params.id)) {
    return next();
  }
  const tab = String(req.query.tab || "general");
  const siteError = typeof req.query.siteError === "string" ? req.query.siteError : "";
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.id },
    select: {
      ...CUSTOMER_SAFE_SELECT,
      sites: true,
      priceLists: { include: { product: true } },
      _count: { select: { sites: true } },
    },
  });
  if (!customer) return res.status(404).send("Client introuvable");
  const products = await prisma.product.findMany({ orderBy: { name: "asc" } });

  let portalFlashPassword = null;
  const flashKey = typeof req.query.pwdFlash === "string" ? req.query.pwdFlash : "";
  if (flashKey) {
    const entry = portalCredentialsFlash.get(flashKey);
    if (entry && entry.customerId === customer.id && Date.now() < entry.exp) {
      portalFlashPassword = entry.password;
      portalCredentialsFlash.delete(flashKey);
    }
  }

  return res.render("customer-detail", {
    customer,
    tab,
    products,
    paymentTermsOptions: PAYMENT_TERMS,
    siteError,
    portalFlashPassword,
  });
});

router.post("/:id/general", async (req, res) => {
  const data = { ...normalizeGeneralPayload(req.body), sites: [{ label: "placeholder", fullAddress: "placeholder" }] };
  const parsed = customerSchema.safeParse(data);
  if (!parsed.success) {
    return res.status(400).send(parsed.error.issues.map((i) => i.message).join(" | "));
  }
  const emailUpd =
    parsed.data.email && String(parsed.data.email).trim() ? String(parsed.data.email).trim().toLowerCase() : null;
  await prisma.customer.update({
    where: { id: req.params.id },
    data: {
      companyName: parsed.data.companyName,
      countryCode: parsed.data.countryCode,
      siret: parsed.data.siret || null,
      vatNumber: parsed.data.vatNumber || null,
      email: emailUpd,
      phone: parsed.data.phone || null,
      website: parsed.data.website || null,
      notes: parsed.data.notes || null,
      paymentTerms: parsed.data.paymentTerms,
      isActive: parsed.data.isActive ?? true,
    },
  });
  return res.redirect(`/dashboard/customers/${req.params.id}?tab=general`);
});

router.post("/:id/sites", async (req, res) => {
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*"))) {
    return res.status(403).send("Acces refuse");
  }
  await prisma.customerSite.create({
    data: {
      customerId: req.params.id,
      label: req.body.label,
      fullAddress: req.body.fullAddress,
      isDefault: parseBool(req.body.isDefault),
      isShipping: parseBool(req.body.isShipping),
      isBilling: parseBool(req.body.isBilling),
      contactName: req.body.contactName || null,
      contactEmail: req.body.contactEmail || null,
      contactPhone: req.body.contactPhone || null,
    },
  });
  return res.redirect(`/dashboard/customers/${req.params.id}?tab=sites`);
});

router.post("/:id/sites/:siteId/delete", async (req, res) => {
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*"))) {
    return res.status(403).send("Acces refuse");
  }
  const remaining = await prisma.customerSite.count({ where: { customerId: req.params.id } });
  if (remaining <= 1) {
    const msg = encodeURIComponent(
      "Impossible de supprimer le dernier site : ajoutez d'abord un autre site sur cette page, puis supprimez celui-ci si besoin.",
    );
    return res.redirect(`/dashboard/customers/${req.params.id}?tab=sites&siteError=${msg}`);
  }
  await prisma.customerSite.delete({ where: { id: req.params.siteId } });
  return res.redirect(`/dashboard/customers/${req.params.id}?tab=sites`);
});

router.post("/:id/sites/:siteId/update", async (req, res) => {
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*"))) {
    return res.status(403).send("Acces refuse");
  }
  await prisma.customerSite.update({
    where: { id: req.params.siteId },
    data: {
      label: req.body.label,
      fullAddress: req.body.fullAddress,
      isDefault: parseBool(req.body.isDefault),
      isShipping: parseBool(req.body.isShipping),
      isBilling: parseBool(req.body.isBilling),
      contactName: req.body.contactName || null,
      contactEmail: req.body.contactEmail || null,
      contactPhone: req.body.contactPhone || null,
    },
  });
  return res.redirect(`/dashboard/customers/${req.params.id}?tab=sites`);
});

router.post("/:id/prices", async (req, res) => {
  await prisma.customerPriceList.create({
    data: {
      customerId: req.params.id,
      productId: req.body.productId,
      customPrice: Number(req.body.customPrice || 0),
      discountPercent: Number(req.body.discountPercent || 0),
      minQuantity: Number(req.body.minQuantity || 1),
      validFrom: req.body.validFrom ? new Date(req.body.validFrom) : null,
      validTo: req.body.validTo ? new Date(req.body.validTo) : null,
    },
  });
  return res.redirect(`/dashboard/customers/${req.params.id}?tab=pricing`);
});

router.post("/:id/prices/:priceId/delete", async (req, res) => {
  await prisma.customerPriceList.delete({ where: { id: req.params.priceId } });
  return res.redirect(`/dashboard/customers/${req.params.id}?tab=pricing`);
});

router.post("/:id/portal-test-credentials", async (req, res, next) => {
  if (["export", "import", "new"].includes(req.params.id)) {
    return next();
  }
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*"))) {
    return res.status(403).send("Acces refuse");
  }
  const customer = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, email: true } });
  if (!customer) return res.status(404).send("Client introuvable");
  const emailNorm = customer.email ? String(customer.email).trim().toLowerCase() : "";
  if (!emailNorm) {
    return res.status(400).send("Renseignez l'e-mail du client (identifiant portail), enregistrez, puis réessayez.");
  }

  const plainPortalPassword = generatePortalPassword();
  const portalPasswordHash = await hashPassword(plainPortalPassword);
  const sup = await ensureCustomerSupabaseAuthUser(emailNorm, plainPortalPassword);
  await prisma.customer.update({
    where: { id: customer.id },
    data: { portalPasswordHash },
  });
  if (sup.ok) await safeAttachCustomerAuthUid(customer.id, sup.authUid);

  const key = crypto.randomUUID();
  portalCredentialsFlash.set(key, {
    customerId: customer.id,
    password: plainPortalPassword,
    exp: Date.now() + 5 * 60 * 1000,
  });

  return res.redirect(`/dashboard/customers/${customer.id}?tab=general&pwdFlash=${encodeURIComponent(key)}`);
});

router.post("/:id/invite-portal", async (req, res) => {
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*"))) {
    return res.status(403).send("Acces refuse");
  }
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.id },
    select: { id: true, email: true, companyName: true, code: true },
  });
  if (!customer) return res.status(404).send("Client introuvable");
  const emailNorm = customer.email ? String(customer.email).trim().toLowerCase() : "";
  if (!emailNorm) return res.status(400).send("Le client n'a pas d'e-mail : renseignez-le dans les informations generales.");

  const plainPortalPassword = generatePortalPassword();
  const portalPasswordHash = await hashPassword(plainPortalPassword);
  const sup = await ensureCustomerSupabaseAuthUser(emailNorm, plainPortalPassword);
  await prisma.customer.update({
    where: { id: customer.id },
    data: { email: emailNorm, portalPasswordHash },
  });
  if (sup.ok) await safeAttachCustomerAuthUid(customer.id, sup.authUid);

  const baseUrl = process.env.APP_BASE_URL || "http://127.0.0.1:3000";
  const tpl = clientPortalCredentialsTemplate({
    customerName: customer.companyName,
    loginUrl: `${baseUrl}/login`,
    identifier: emailNorm,
    plainPassword: plainPortalPassword,
    code: customer.code,
  });
  await enqueueEmail({
    organizationId: req.user.organizationId,
    toEmail: emailNorm,
    subject: tpl.subject,
    html: tpl.html,
  });
  return res.redirect(`/dashboard/customers/${customer.id}?tab=general`);
});

router.get("/export/csv", async (_req, res) => {
  const customers = await prisma.customer.findMany({
    select: { code: true, companyName: true, email: true, phone: true, paymentTerms: true, isActive: true, sites: { select: { id: true } } },
    orderBy: { code: "asc" },
  });
  const rows = [
    "code,companyName,email,phone,paymentTerms,isActive,sitesCount",
    ...customers.map((c) =>
      [c.code, c.companyName, c.email || "", c.phone || "", c.paymentTerms, c.isActive, c.sites.length]
        .map((v) => `"${String(v).replaceAll('"', '""')}"`)
        .join(",")
    ),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=customers.csv");
  return res.send(rows.join("\n"));
});

router.get("/export/xlsx", async (_req, res) => {
  const customers = await prisma.customer.findMany({
    select: { code: true, companyName: true, email: true, phone: true, paymentTerms: true, isActive: true, sites: { select: { id: true } } },
    orderBy: { code: "asc" },
  });
  const data = customers.map((c) => ({
    code: c.code,
    companyName: c.companyName,
    email: c.email || "",
    phone: c.phone || "",
    paymentTerms: c.paymentTerms,
    isActive: c.isActive,
    sitesCount: c.sites.length,
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Customers");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=customers.xlsx");
  return res.send(buffer);
});

router.get("/import", (_req, res) => {
  return res.render("customers-import", { preview: null, headers: [], rows: [], report: null });
});

router.post("/import/preview", ensureImportCsvFile, (req, res) => {
  if (!req.file) return res.status(400).send("Fichier CSV obligatoire");
  const raw = req.file.buffer.toString("utf-8");
  const records = parse(raw, { columns: true, skip_empty_lines: true });
  const headers = Object.keys(records[0] || {});
  const rows = records.slice(0, 10);
  return res.render("customers-import", { preview: JSON.stringify(records), headers, rows, report: null });
});

router.post("/import/commit", async (req, res) => {
  const records = JSON.parse(req.body.previewData || "[]");
  const mapping = {
    companyName: req.body.mapCompanyName,
    email: req.body.mapEmail,
    phone: req.body.mapPhone,
    countryCode: req.body.mapCountryCode,
    siret: req.body.mapSiret,
    vatNumber: req.body.mapVatNumber,
  };

  const errors = [];
  let imported = 0;

  for (let index = 0; index < records.length; index++) {
    const rec = records[index];
    const payload = {
      companyName: rec[mapping.companyName] || "Client CSV",
      email: rec[mapping.email] || "",
      phone: rec[mapping.phone] || "",
      countryCode: (rec[mapping.countryCode] || "FR").toUpperCase(),
      siret: rec[mapping.siret] || "",
      vatNumber: rec[mapping.vatNumber] || "",
      paymentTerms: "NET_30",
      isActive: true,
      website: "",
      notes: "",
      sites: [{ label: "Siege", fullAddress: "Adresse a completer", isDefault: true, isShipping: true, isBilling: true }],
    };
    const parsed = customerSchema.safeParse(payload);
    if (!parsed.success) {
      errors.push({ row: index + 1, message: parsed.error.issues.map((i) => i.message).join(", ") });
      continue;
    }
    try {
      const code = await nextCustomerCode();
      const organizationId = req.user.organizationId;
      await prisma.customer.create({
        data: {
          code,
          companyName: parsed.data.companyName,
          email: parsed.data.email || null,
          phone: parsed.data.phone || null,
          countryCode: parsed.data.countryCode,
          siret: parsed.data.siret || null,
          vatNumber: parsed.data.vatNumber || null,
          paymentTerms: parsed.data.paymentTerms,
          isActive: parsed.data.isActive,
          sites: { create: customerSitesCreateData(parsed.data.sites, organizationId) },
        },
      });
      imported += 1;
    } catch (error) {
      errors.push({ row: index + 1, message: error.message });
    }
  }
  return res.render("customers-import", {
    preview: null,
    headers: [],
    rows: [],
    report: { imported, failed: errors.length, errors },
  });
});

module.exports = router;
