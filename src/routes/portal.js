const express = require("express");
const { Prisma } = require("@prisma/client");
const { prisma } = require("../db");
const { getPriceForCustomer } = require("../utils/pricing");
const { computeOrderTotals, STATUS, nextOrderNumber } = require("../utils/orders");
const {
  CLIENT_PORTAL_COOKIE,
  signClientPortalToken,
  setClientPortalCookie,
  clearClientPortalCookie,
  verifyClientPortalToken,
  comparePassword,
} = require("../utils/auth");
const { requireClientPortalAuth } = require("../middleware/portalAuth");
const { attachPortalNotifications } = require("../middleware/portalNotifications");
const { TYPE, notifyUsersByRoles } = require("../utils/notifications");
const { assertPortalCartStockAvailable } = require("../utils/orderStock");

const router = express.Router();

/** Pages portail avec en-tête : alertes chargées pour la cloche et le bloc « Vos alertes ». */
const portalAuthed = [requireClientPortalAuth, attachPortalNotifications];

/** Pages portail toujours recalculées côté serveur (pas de cache navigateur / proxy sur le catalogue). */
function portalNoCache(_req, res, next) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
}
router.use(portalNoCache);

/** Empreinte du catalogue pour ce client (produits, catégories, prix négociés) — change dès qu’un admin modifie quelque chose. */
async function computeCatalogRevision(customerId, organizationId) {
  const [pAgg, cAgg, plAgg, activeCount] = await Promise.all([
    prisma.product.aggregate({
      where: { organizationId },
      _max: { updatedAt: true },
    }),
    prisma.productCategory.aggregate({
      where: { organizationId },
      _max: { updatedAt: true },
    }),
    prisma.customerPriceList.aggregate({
      where: { customerId, organizationId },
      _max: { updatedAt: true },
    }),
    prisma.product.count({
      where: {
        organizationId,
        OR: [{ isActive: true }, { portalRuptureStock: true }],
      },
    }),
  ]);
  const pt = pAgg._max.updatedAt?.getTime() || 0;
  const ct = cAgg._max.updatedAt?.getTime() || 0;
  const plt = plAgg._max.updatedAt?.getTime() || 0;
  return `${pt}|${ct}|${plt}|${activeCount}`;
}

function portalSlugify(text) {
  return (
    String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "_"
  );
}

function redirectAfterPortalNotifyRead(req, res, fallback = "/portal/notifications") {
  const ref = req.get("referer");
  if (!ref) return res.redirect(fallback);
  try {
    const u = new URL(ref);
    const host = req.get("host");
    if (host && u.host === host && u.pathname.startsWith("/portal")) {
      return res.redirect(ref);
    }
  } catch (_) {
    /* ignore */
  }
  return res.redirect(fallback);
}

function stripHtmlShort(html, maxLen) {
  if (!html) return "";
  const t = String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen).trimEnd()}…`;
}

router.get("/login", (req, res) => {
  const token = req.cookies[CLIENT_PORTAL_COOKIE];
  if (token) {
    try {
      verifyClientPortalToken(token);
      return res.redirect("/portal");
    } catch (_) {
      /* jeton expiré */
    }
  }
  return res.render("portal-login", { loginError: null });
});

function codesMatch(input, stored) {
  const a = String(input || "")
    .trim()
    .toUpperCase();
  const b = String(stored || "")
    .trim()
    .toUpperCase();
  return a.length > 0 && a === b;
}

async function portalCredentialsValid(customer, password, code) {
  const pwd = String(password || "").trim();
  const codeOk = codesMatch(code, customer.code);
  if (customer.portalPasswordHash) {
    const pwdOk = pwd.length > 0 && (await comparePassword(pwd, customer.portalPasswordHash));
    /* Mot de passe OU code client (ex. test sans copier le MDP reçu par e-mail) */
    return pwdOk || codeOk;
  }
  return codeOk;
}

router.post("/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const code = String(req.body.code || "");
  if (!email) {
    return res.status(400).render("portal-login", { loginError: "L’adresse e-mail est obligatoire." });
  }

  // SQLite : comparaison insensible à la casse (les fiches peuvent avoir été créées avec une casse différente)
  const emailHits = await prisma.$queryRaw(
    Prisma.sql`SELECT id, isActive FROM Customer WHERE LOWER(TRIM(COALESCE(email, ''))) = ${email} LIMIT 1`,
  );
  const hit = emailHits[0];
  if (!hit) {
    return res.status(401).render("portal-login", {
      loginError:
        "Aucun compte pour cet e-mail. Vérifiez l’orthographe (identifiant = e-mail enregistré chez votre fournisseur).",
    });
  }
  if (!hit.isActive) {
    return res.status(401).render("portal-login", {
      loginError: "Ce compte est désactivé. Contactez votre fournisseur.",
    });
  }

  const customer = await prisma.customer.findUnique({ where: { id: hit.id } });
  if (!customer) {
    return res.status(401).render("portal-login", {
      loginError: "Compte introuvable. Contactez votre fournisseur.",
    });
  }

  const ok = await portalCredentialsValid(customer, password, code);
  if (!ok) {
    const hint = customer.portalPasswordHash
      ? "Indiquez le mot de passe reçu par e-mail, ou votre code client (ex. CLI-0001) à la place du mot de passe."
      : "Indiquez votre code client (ex. CLI-0001) en laissant le mot de passe vide.";
    return res.status(401).render("portal-login", {
      loginError: `Connexion refusée. ${hint}`,
    });
  }

  const token = signClientPortalToken(customer);
  setClientPortalCookie(res, token);
  return res.redirect("/portal");
});

router.post("/logout", (_req, res) => {
  clearClientPortalCookie(res);
  return res.redirect("/portal/login");
});

router.get("/api/catalog-revision", requireClientPortalAuth, async (req, res) => {
  try {
    const revision = await computeCatalogRevision(req.portalCustomer.id, req.portalCustomer.organizationId);
    return res.type("json").send(JSON.stringify({ revision }));
  } catch (e) {
    console.error("portal catalog-revision", e);
    return res.status(500).type("json").send(JSON.stringify({ error: "revision_failed" }));
  }
});

router.get("/", portalAuthed, async (req, res) => {
  const orderSuccess = req.query.success === "1";
  const orderError = typeof req.query.error === "string" ? req.query.error : "";

  const [productsRaw, orders, invoices, sites] = await Promise.all([
    prisma.product.findMany({
      where: {
        organizationId: req.portalCustomer.organizationId,
        OR: [{ isActive: true }, { portalRuptureStock: true }],
      },
      include: { category: { include: { parent: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.order.findMany({ where: { customerId: req.portalCustomer.id }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.invoice.findMany({ where: { customerId: req.portalCustomer.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.customerSite.findMany({ where: { customerId: req.portalCustomer.id }, orderBy: { isDefault: "desc" } }),
  ]);
  const catalogRevision = await computeCatalogRevision(req.portalCustomer.id, req.portalCustomer.organizationId);
  function portalProductSortKey(p) {
    const parent = p.category?.parent;
    const pa = parent?.sortOrder ?? 999;
    const pb = p.category?.sortOrder ?? 999;
    return [pa, pb, (parent?.name || "").toLowerCase(), (p.category?.name || "").toLowerCase(), p.name.toLowerCase()].join("\0");
  }
  productsRaw.sort((a, b) => portalProductSortKey(a).localeCompare(portalProductSortKey(b)));

  const pricedProducts = [];
  for (const p of productsRaw) {
    const sectionTitle = p.category?.parent?.name || "Catalogue";
    const subsectionTitle = p.category?.name || "";
    const sectionSlug = portalSlugify(sectionTitle);
    const subsectionSlug = subsectionTitle ? portalSlugify(subsectionTitle) : "";
    const orderable = Boolean(p.isActive) && !p.portalRuptureStock;
    pricedProducts.push({
      id: p.id,
      name: p.name,
      sku: p.sku,
      sectionTitle,
      subsectionTitle,
      sectionSlug,
      subsectionSlug,
      sectionSort: p.category?.parent?.sortOrder ?? 999,
      subsectionSort: p.category?.sortOrder ?? 999,
      searchKey: `${p.name} ${p.sku} ${sectionTitle} ${subsectionTitle}`.toLowerCase().replace(/"/g, ""),
      descriptionShort: stripHtmlShort(p.description, 140),
      image: (p.imageUrls || "").split("|").filter(Boolean)[0] || null,
      supplierUrl: p.supplierUrl || null,
      technicalSheetUrl: p.technicalSheetUrl || null,
      price: await getPriceForCustomer(p, req.portalCustomer.id),
      vatRate: Number(p.vatRate),
      orderable,
      portalRuptureStock: Boolean(p.portalRuptureStock),
    });
  }

  const seenSectionSlugs = new Set();
  const catalogFilterSections = [];
  const catalogFilterSubsectionsFlat = [];
  const subsectionKeys = new Set();
  for (const p of pricedProducts) {
    if (!seenSectionSlugs.has(p.sectionSlug)) {
      seenSectionSlugs.add(p.sectionSlug);
      catalogFilterSections.push({ slug: p.sectionSlug, label: p.sectionTitle });
    }
    if (p.subsectionSlug) {
      const k = `${p.sectionSlug}|||${p.subsectionSlug}`;
      if (!subsectionKeys.has(k)) {
        subsectionKeys.add(k);
        catalogFilterSubsectionsFlat.push({
          sectionSlug: p.sectionSlug,
          subsectionSlug: p.subsectionSlug,
          label: p.subsectionTitle,
        });
      }
    }
  }

  return res.render("portal-dashboard", {
    customer: req.portalCustomer,
    products: pricedProducts,
    catalogFilterSections,
    catalogFilterSubsectionsFlat,
    orders,
    invoices,
    sites,
    orderSuccess,
    orderError,
    catalogRevision,
    portalPath: req.originalUrl.split("?")[0],
  });
});

const PORTAL_ORDERS_PAGE_SIZE = 25;

router.get("/notifications", portalAuthed, async (req, res) => {
  let notifications = [];
  try {
    notifications = await prisma.portalNotification.findMany({
      where: { customerId: req.portalCustomer.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  } catch (err) {
    console.error("portal notifications list", err.message);
  }
  return res.render("portal-notifications", {
    customer: req.portalCustomer,
    notifications,
    portalPath: req.originalUrl.split("?")[0],
  });
});

router.get("/commandes", portalAuthed, async (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const where = { customerId: req.portalCustomer.id };
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PORTAL_ORDERS_PAGE_SIZE,
      take: PORTAL_ORDERS_PAGE_SIZE,
    }),
    prisma.order.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PORTAL_ORDERS_PAGE_SIZE));
  function pageHref(n) {
    const p = new URLSearchParams();
    p.set("page", String(n));
    return `/portal/commandes?${p.toString()}`;
  }
  return res.render("portal-orders", {
    customer: req.portalCustomer,
    orders,
    page,
    totalPages,
    totalCount: total,
    pageHref,
    portalPath: req.originalUrl.split("?")[0],
  });
});

router.get("/commandes/:id", portalAuthed, async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, customerId: req.portalCustomer.id },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      deliverySite: true,
      billingSite: true,
    },
  });
  if (!order) return res.status(404).send("Commande introuvable.");
  return res.render("portal-order-detail", {
    customer: req.portalCustomer,
    order,
    portalPath: req.originalUrl.split("?")[0],
  });
});

router.post("/notifications/read-all", requireClientPortalAuth, async (req, res) => {
  try {
    await prisma.portalNotification.updateMany({
      where: { customerId: req.portalCustomer.id, isRead: false },
      data: { isRead: true },
    });
  } catch (err) {
    console.error("portal notifications read-all", err.message);
  }
  return redirectAfterPortalNotifyRead(req, res, "/portal/notifications");
});

router.post("/notifications/:id/read", requireClientPortalAuth, async (req, res) => {
  const n = await prisma.portalNotification.findFirst({
    where: { id: req.params.id, customerId: req.portalCustomer.id },
  });
  if (n) {
    await prisma.portalNotification.update({ where: { id: n.id }, data: { isRead: true } });
  }
  return redirectAfterPortalNotifyRead(req, res, "/portal/notifications");
});

router.post("/orders", requireClientPortalAuth, async (req, res) => {
  const redirectErr = (msg) => res.redirect(`/portal?error=${encodeURIComponent(msg)}`);

  let rawLines;
  try {
    rawLines = JSON.parse(req.body.linesJson || "[]");
  } catch {
    return redirectErr("Données du panier invalides.");
  }
  if (!Array.isArray(rawLines) || !rawLines.length) {
    return redirectErr("Votre panier est vide.");
  }

  const deliverySiteId = String(req.body.deliverySiteId || "").trim() || null;
  const billingSiteId = String(req.body.billingSiteId || "").trim() || null;
  const customerSites = await prisma.customerSite.findMany({
    where: { customerId: req.portalCustomer.id },
    select: { id: true },
  });
  const siteIds = new Set(customerSites.map((s) => s.id));
  if (!deliverySiteId || !billingSiteId || !siteIds.has(deliverySiteId) || !siteIds.has(billingSiteId)) {
    return redirectErr("Merci de sélectionner des sites de livraison et de facturation valides.");
  }

  const sanitizedLines = [];
  for (const l of rawLines) {
    if (!l || !l.productId) return redirectErr("Une ligne du panier est incomplète.");
    const product = await prisma.product.findFirst({
      where: {
        id: l.productId,
        organizationId: req.portalCustomer.organizationId,
        OR: [{ isActive: true }, { portalRuptureStock: true }],
      },
    });
    if (!product) {
      return redirectErr("Un produit n’est plus disponible. Actualisez la page et refaites votre panier.");
    }
    if (!product.isActive || product.portalRuptureStock) {
      return redirectErr("Un produit est en rupture de stock ou indisponible à la commande. Actualisez la page et videz le panier.");
    }
    const expectedPrice = await getPriceForCustomer(product, req.portalCustomer.id);
    const clientPrice = Number(l.unitPriceHt);
    if (Number.isNaN(clientPrice) || Math.abs(clientPrice - expectedPrice) > 0.02) {
      return redirectErr("Les prix ont été mis à jour. Videz le panier et réajoutez les articles.");
    }
    const qty = Math.min(9999, Math.max(1, Math.floor(Number(l.quantity) || 0)));
    if (qty < 1) return redirectErr("Quantité invalide.");
    const line = {
      productId: product.id,
      productNameSnapshot: product.name,
      productSkuSnapshot: product.sku,
      quantity: qty,
      unitPriceHt: expectedPrice,
      discountPercent: 0,
      vatRate: Number(product.vatRate),
    };
    sanitizedLines.push(line);
  }

  const stockErr = await assertPortalCartStockAvailable(prisma, req.portalCustomer.organizationId, sanitizedLines);
  if (stockErr) {
    return redirectErr(stockErr);
  }

  let order;
  try {
    const org = await prisma.organization.findUnique({ where: { id: req.portalCustomer.organizationId } });
    const totals = computeOrderTotals(sanitizedLines);
    // Portail client: validation toujours manuelle par un administrateur/manager.
    const status = STATUS.PENDING_APPROVAL;
    const number = await nextOrderNumber(prisma, req.portalCustomer.organizationId);
    const manager = await prisma.user.findFirst({
      where: { organizationId: req.portalCustomer.organizationId, role: { in: ["OWNER", "ADMIN", "MANAGER"] } },
    });
    const anyStaff = await prisma.user.findFirst({
      where: { organizationId: req.portalCustomer.organizationId },
    });
    const createdById = manager?.id || anyStaff?.id;
    if (!createdById) {
      return redirectErr("Votre fournisseur doit configurer au moins un utilisateur pour recevoir les commandes.");
    }

    order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          number,
          customerId: req.portalCustomer.id,
          deliverySiteId,
          billingSiteId,
          status,
          totalHt: totals.totalHt,
          totalTva: totals.totalTva,
          totalTtc: totals.totalTtc,
          notes: String(req.body.notes || "").trim().slice(0, 2000) || null,
          createdById,
        },
      });
      for (let i = 0; i < sanitizedLines.length; i++) {
        const l = sanitizedLines[i];
        const lt = computeOrderTotals([l]);
        await tx.orderLine.create({
          data: {
            orderId: created.id,
            productId: l.productId,
            productNameSnapshot: l.productNameSnapshot,
            productSkuSnapshot: l.productSkuSnapshot,
            quantity: l.quantity,
            unitPriceHt: l.unitPriceHt,
            discountPercent: l.discountPercent,
            vatRate: l.vatRate,
            lineTotalHt: lt.totalHt,
            lineTotalTtc: lt.totalTtc,
            sortOrder: i + 1,
          },
        });
      }
      await tx.orderStatusHistory.create({
        data: {
          orderId: created.id,
          fromStatus: null,
          toStatus: created.status,
          changedById: created.createdById,
          comment: "Commande portail client",
        },
      });
      return created;
    });
  } catch (err) {
    console.error("portal order", err);
    return redirectErr("Impossible d’enregistrer la commande pour le moment. Réessayez plus tard.");
  }

  await notifyUsersByRoles({
    organizationId: req.portalCustomer.organizationId,
    roles: ["MANAGER", "ADMIN", "OWNER"],
    type: TYPE.ORDER_RECEIVED,
    title: "Nouvelle commande portail",
    message: `Commande ${order.number} reçue depuis le portail client.`,
    link: `/dashboard/orders/${order.id}`,
  });
  return res.redirect("/portal?success=1");
});

module.exports = router;
