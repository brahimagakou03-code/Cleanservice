const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { parse } = require("csv-parse/sync");
const { prisma } = require("../db");
const { can } = require("../utils/rbac");
const { getPriceForCustomer, syncCustomerPriceListsAfterProductBaseChange } = require("../utils/pricing");
const { ensureCatalogProductImages, ensureImportCsvFile } = require("../middleware/earlyMultipartBeforeCsrf");

const router = express.Router();
const units = ["piece", "kilogramme", "litre", "metre", "heure", "carton", "palette"];
const vatRates = ["20", "10", "5.5", "2.1", "0"];
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

function slugify(text) {
  return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseImages(value) {
  if (!value) return [];
  return String(value).split("|").filter(Boolean);
}

async function nextSku(organizationId) {
  const last = await prisma.product.findFirst({
    where: { organizationId },
    orderBy: { sku: "desc" },
    select: { sku: true },
  });
  const n = last?.sku?.startsWith("SKU-") ? Number(last.sku.replace("SKU-", "")) : 0;
  return `SKU-${String((n || 0) + 1).padStart(5, "0")}`;
}

function buildCategoryTree(items, parentId = null, depth = 0) {
  const list = items.filter((x) => x.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  return list.flatMap((item) => [{ ...item, depth }, ...buildCategoryTree(items, item.id, depth + 1)]);
}

async function descendantsIds(categoryId, organizationId) {
  const all = await prisma.productCategory.findMany({
    where: { organizationId },
  });
  const map = new Map();
  all.forEach((c) => {
    if (!map.has(c.parentId || "root")) map.set(c.parentId || "root", []);
    map.get(c.parentId || "root").push(c.id);
  });
  const out = [categoryId];
  const stack = [categoryId];
  while (stack.length) {
    const current = stack.pop();
    const children = map.get(current) || [];
    children.forEach((id) => {
      out.push(id);
      stack.push(id);
    });
  }
  return out;
}

const CATALOG_PAGE_SIZES = [25, 50, 100, 250];

router.get("/", async (req, res) => {
  if (!(can(req.user.role, "products:manage") || can(req.user.role, "*") || can(req.user.role, "read:all"))) return res.status(403).send("Acces refuse");
  const organizationId = req.user.organizationId;
  const page = Math.max(Number(req.query.page || 1), 1);
  const perPageRaw = Number.parseInt(String(req.query.perPage || "100"), 10);
  const pageSize = CATALOG_PAGE_SIZES.includes(perPageRaw) ? perPageRaw : 100;
  const view = req.query.view === "list" ? "list" : "grid";
  const q = String(req.query.q || "").trim();
  const categoryId = String(req.query.categoryId || "");
  const status = String(req.query.status || "");
  const minPriceRaw = req.query.minPrice ? Number(String(req.query.minPrice).replace(",", ".")) : null;
  const maxPriceRaw = req.query.maxPrice ? Number(String(req.query.maxPrice).replace(",", ".")) : null;
  const minPrice = Number.isFinite(minPriceRaw) ? minPriceRaw : null;
  const maxPrice = Number.isFinite(maxPriceRaw) ? maxPriceRaw : null;
  const sortBy = ["name", "basePriceHt", "stockQty", "createdAt"].includes(req.query.sortBy) ? req.query.sortBy : "createdAt";
  const sortDir = req.query.sortDir === "asc" ? "asc" : "desc";

  let categoryFilter = undefined;
  if (categoryId) {
    const exists = await prisma.productCategory.findFirst({
      where: { id: categoryId, organizationId },
      select: { id: true },
    });
    if (exists) {
      const ids = await descendantsIds(categoryId, organizationId);
      categoryFilter = { in: ids };
    }
  }
  const where = {
    organizationId,
    ...(q
      ? {
          OR: [{ name: { contains: q } }, { sku: { contains: q } }, { description: { contains: q } }],
        }
      : {}),
    ...(categoryFilter ? { categoryId: categoryFilter } : {}),
    ...(status === "active" ? { isActive: true } : {}),
    ...(status === "inactive" ? { isActive: false } : {}),
    ...((minPrice !== null || maxPrice !== null)
      ? { basePriceHt: { ...(minPrice !== null ? { gte: minPrice } : {}), ...(maxPrice !== null ? { lte: maxPrice } : {}) } }
      : {}),
  };

  const [products, total, categories] = await Promise.all([
    prisma.product.findMany({ where, include: { category: true }, orderBy: { [sortBy]: sortDir }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.product.count({ where }),
    prisma.productCategory.findMany({ where: { organizationId } }),
  ]);

  const rangeFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeTo = Math.min(page * pageSize, total);
  return res.render("catalog-list", {
    products,
    totalCount: total,
    page,
    pageSize,
    catalogPageSizes: CATALOG_PAGE_SIZES,
    rangeFrom,
    rangeTo,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    view,
    filters: { q, categoryId, status, minPrice: req.query.minPrice || "", maxPrice: req.query.maxPrice || "", sortBy, sortDir },
    categories: buildCategoryTree(categories),
  });
});

router.get("/new", async (req, res) => {
  const categories = await prisma.productCategory.findMany({ where: { organizationId: req.user.organizationId } });
  return res.render("catalog-form", { product: null, categories: buildCategoryTree(categories), units, vatRates, errors: [] });
});

router.post("/", ensureCatalogProductImages, async (req, res) => {
  const sku = req.body.sku?.trim() || (await nextSku(req.user.organizationId));
  const imageUrls = catalogImageFiles(req).map((f) => `/uploads/${f.filename}`);
  const supplierUrl = resolveSheetField(req.body.supplierUrl, firstUploadedSheetPath(req, "supplierSheetPdf"));
  const technicalSheetUrl = resolveSheetField(req.body.technicalSheetUrl, firstUploadedSheetPath(req, "technicalSheetPdf"));
  try {
    const created = await prisma.product.create({
      data: {
        sku,
        name: req.body.name,
        description: req.body.description || null,
        categoryId: req.body.categoryId || null,
        unit: units.includes(req.body.unit) ? req.body.unit : "piece",
        basePriceHt: Number(req.body.basePriceHt || 0),
        vatRate: vatRates.includes(String(req.body.vatRate)) ? String(req.body.vatRate) : "20",
        isActive: req.body.isActive === "on",
        portalRuptureStock: req.body.portalRuptureStock === "on",
        minOrderQty: Number(req.body.minOrderQty || 1),
        stockQty: req.body.stockQty === "" ? null : Number(req.body.stockQty),
        weightKg: req.body.weightKg === "" ? null : Number(req.body.weightKg),
        dimensions: req.body.dimensions || null,
        imageUrls: imageUrls.join("|"),
        supplierUrl,
        technicalSheetUrl,
      },
    });
    return res.redirect(`/dashboard/catalog/${created.id}`);
  } catch (error) {
    const categories = await prisma.productCategory.findMany({ where: { organizationId: req.user.organizationId } });
    return res.status(400).render("catalog-form", { product: null, categories: buildCategoryTree(categories), units, vatRates, errors: [error.message] });
  }
});

router.get("/:id", async (req, res, next) => {
  if (["categories", "import", "export", "new"].includes(req.params.id)) return next();
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { category: true, customerPrices: { include: { customer: { select: CUSTOMER_SAFE_SELECT } } } },
  });
  if (!product) return res.status(404).send("Produit introuvable");
  const categories = await prisma.productCategory.findMany({ where: { organizationId: req.user.organizationId } });
  return res.render("catalog-form", { product, categories: buildCategoryTree(categories), units, vatRates, errors: [] });
});

router.post("/:id", ensureCatalogProductImages, async (req, res, next) => {
  if (["categories", "import", "export", "new"].includes(req.params.id)) return next();
  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  });
  if (!existing) return res.status(404).send("Produit introuvable");
  const newImages = catalogImageFiles(req).map((f) => `/uploads/${f.filename}`);
  const oldImages = parseImages(existing.imageUrls);
  const newBasePriceHt = Number(req.body.basePriceHt || 0);
  const supplierUrl = resolveSheetField(req.body.supplierUrl, firstUploadedSheetPath(req, "supplierSheetPdf"));
  const technicalSheetUrl = resolveSheetField(req.body.technicalSheetUrl, firstUploadedSheetPath(req, "technicalSheetPdf"));
  try {
    await prisma.product.update({
      where: { id: existing.id },
      data: {
        sku: req.body.sku?.trim() || existing.sku,
        name: req.body.name,
        description: req.body.description || null,
        categoryId: req.body.categoryId || null,
        unit: units.includes(req.body.unit) ? req.body.unit : existing.unit,
        basePriceHt: newBasePriceHt,
        vatRate: vatRates.includes(String(req.body.vatRate)) ? String(req.body.vatRate) : "20",
        isActive: req.body.isActive === "on",
        portalRuptureStock: req.body.portalRuptureStock === "on",
        minOrderQty: Number(req.body.minOrderQty || 1),
        stockQty: req.body.stockQty === "" ? null : Number(req.body.stockQty),
        weightKg: req.body.weightKg === "" ? null : Number(req.body.weightKg),
        dimensions: req.body.dimensions || null,
        imageUrls: [...oldImages, ...newImages].slice(0, 5).join("|"),
        supplierUrl,
        technicalSheetUrl,
      },
    });
  } catch (error) {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, organizationId: req.user.organizationId },
      include: { category: true, customerPrices: { include: { customer: { select: CUSTOMER_SAFE_SELECT } } } },
    });
    if (!product) return res.status(404).send("Produit introuvable");
    const categories = await prisma.productCategory.findMany({ where: { organizationId: req.user.organizationId } });
    return res.status(400).render("catalog-form", {
      product,
      categories: buildCategoryTree(categories),
      units,
      vatRates,
      errors: [error.message],
    });
  }
  if (existing.supplierUrl && existing.supplierUrl !== supplierUrl) safeUnlinkUpload(existing.supplierUrl);
  if (existing.technicalSheetUrl && existing.technicalSheetUrl !== technicalSheetUrl) safeUnlinkUpload(existing.technicalSheetUrl);
  await syncCustomerPriceListsAfterProductBaseChange(existing.id, existing.basePriceHt, newBasePriceHt);
  return res.redirect(`/dashboard/catalog/${req.params.id}`);
});

router.get("/categories/manage", async (req, res) => {
  const categories = await prisma.productCategory.findMany({ where: { organizationId: req.user.organizationId } });
  return res.render("catalog-categories", { categories: buildCategoryTree(categories) });
});

router.post("/categories", async (req, res) => {
  await prisma.productCategory.create({
    data: {
      name: req.body.name,
      slug: req.body.slug || slugify(req.body.name),
      description: req.body.description || null,
      parentId: req.body.parentId || null,
      sortOrder: Number(req.body.sortOrder || 0),
    },
  });
  return res.redirect("/dashboard/catalog/categories/manage");
});

router.post("/categories/reorder", async (req, res) => {
  const { id, newParentId, newSortOrder } = req.body;
  const result = await prisma.productCategory.updateMany({
    where: { id, organizationId: req.user.organizationId },
    data: { parentId: newParentId || null, sortOrder: Number(newSortOrder || 0) },
  });
  if (result.count === 0) return res.status(404).json({ ok: false });
  return res.json({ ok: true });
});

router.get("/export/csv", async (req, res) => {
  const items = await prisma.product.findMany({
    where: { organizationId: req.user.organizationId },
    include: { category: true },
    orderBy: { name: "asc" },
  });
  const rows = ["sku,name,category,unit,basePriceHt,vatRate,isActive,stockQty,createdAt"];
  items.forEach((p) => {
    rows.push(
      [p.sku, p.name, p.category?.name || "", p.unit, Number(p.basePriceHt), p.vatRate, p.isActive, p.stockQty ?? "", p.createdAt.toISOString()]
        .map((v) => `"${String(v).replaceAll('"', '""')}"`)
        .join(",")
    );
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=catalogue.csv");
  return res.send(rows.join("\n"));
});

router.get("/import", (_req, res) => {
  return res.render("catalog-import", { headers: [], rows: [], rawJson: null, report: null });
});

router.post("/import/preview", ensureImportCsvFile, (req, res) => {
  if (!req.file) return res.status(400).send("CSV requis");
  const records = parse(req.file.buffer.toString("utf-8"), { columns: true, skip_empty_lines: true });
  return res.render("catalog-import", { headers: Object.keys(records[0] || {}), rows: records.slice(0, 10), rawJson: JSON.stringify(records), report: null });
});

router.post("/import/commit", async (req, res) => {
  const records = JSON.parse(req.body.rawJson || "[]");
  const errors = [];
  let imported = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    try {
      const sku = r[req.body.mapSku] || (await nextSku(req.user.organizationId));
      await prisma.product.create({
        data: {
          organizationId: req.user.organizationId,
          sku,
          name: r[req.body.mapName] || `Produit ${i + 1}`,
          description: r[req.body.mapDescription] || null,
          unit: units.includes(r[req.body.mapUnit]) ? r[req.body.mapUnit] : "piece",
          basePriceHt: Number(r[req.body.mapPrice] || 0),
          vatRate: vatRates.includes(String(r[req.body.mapVat])) ? String(r[req.body.mapVat]) : "20",
          isActive: String(r[req.body.mapActive] || "true").toLowerCase() !== "false",
          minOrderQty: Number(r[req.body.mapMinQty] || 1),
          stockQty: r[req.body.mapStock] ? Number(r[req.body.mapStock]) : null,
        },
      });
      imported++;
    } catch (e) {
      errors.push({ row: i + 1, message: e.message });
    }
  }
  return res.render("catalog-import", { headers: [], rows: [], rawJson: null, report: { imported, failed: errors.length, errors } });
});

router.get("/:id/customers-prices", async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  });
  if (!product) return res.status(404).json({ error: "Produit introuvable" });
  const customers = await prisma.customer.findMany({
    where: { organizationId: req.user.organizationId },
    select: { id: true, companyName: true },
    orderBy: { companyName: "asc" },
  });
  const data = [];
  for (const c of customers) {
    const price = await getPriceForCustomer(product, c.id);
    data.push({ customer: c.companyName, price });
  }
  return res.json(data);
});

module.exports = router;
