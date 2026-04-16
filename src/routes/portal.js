const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");
const { prisma } = require("../db");
const { getPriceForCustomer } = require("../utils/pricing");
const { computeOrderTotals, STATUS, nextOrderNumber } = require("../utils/orders");
const { clearClientPortalCookie } = require("../utils/auth");
const { createSupabaseRouteClient } = require("../utils/supabaseExpress");
const { performUnifiedLogin } = require("../services/unifiedLogin");
const { requireClientPortalAuth } = require("../middleware/portalAuth");
const { attachPortalNotifications } = require("../middleware/portalNotifications");
const { TYPE, notifyUsersByRoles } = require("../utils/notifications");
const { assertPortalCartStockAvailable } = require("../utils/orderStock");
const { mergeFormBody } = require("../utils/mergeFormBody");
const { inviteStaffSupabaseUser } = require("../utils/supabaseAuth");
const { Role } = require("../utils/rbac");

const router = express.Router();
const ADMIN_OTP_TTL_MS = 10 * 60 * 1000;
const pendingAdminSignups = new Map();

function limiterKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const nfIp = String(req.headers["x-nf-client-connection-ip"] || "").trim();
  const socketIp = String(req.socket?.remoteAddress || "").trim();
  return forwarded || nfIp || req.ip || socketIp || "unknown";
}

const portalLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Trop de tentatives de connexion. Reessayez dans 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
  validate: false,
});

const adminOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Trop de demandes OTP. Reessayez dans 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
  validate: false,
});

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

function portalSlugifyText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function htmlEscape(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 999999));
}

function hashOtp(email, otp) {
  return crypto
    .createHash("sha256")
    .update(`${String(email || "").trim().toLowerCase()}::${String(otp || "").trim()}`)
    .digest("hex");
}

function cleanupPendingAdminSignups() {
  const now = Date.now();
  for (const [id, entry] of pendingAdminSignups.entries()) {
    if (!entry || entry.expiresAt <= now) pendingAdminSignups.delete(id);
  }
}

function adminOtpTemplate({ firstName, otp, expiresMinutes }) {
  const safeFirstName = htmlEscape(firstName || "Admin");
  const safeOtp = htmlEscape(otp);
  return {
    subject: "Code OTP inscription administrateur",
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;">
      <h2>Inscription administrateur magasin</h2>
      <p>Bonjour ${safeFirstName},</p>
      <p>Votre code OTP est :</p>
      <p style="font-size:28px;letter-spacing:4px;font-weight:700;background:#f3f5f8;padding:12px 16px;border-radius:8px;display:inline-block;">${safeOtp}</p>
      <p>Ce code expire dans ${expiresMinutes} minutes.</p>
      <p>Si vous n'etes pas a l'origine de cette demande, ignorez cet e-mail.</p>
    </div>`,
  };
}

async function sendAdminOtpEmail(toEmail, firstName, otp) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "127.0.0.1",
    port: Number(process.env.SMTP_PORT || 1025),
    secure: false,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
  });
  const mail = adminOtpTemplate({ firstName, otp, expiresMinutes: Math.round(ADMIN_OTP_TTL_MS / 60000) });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || "no-reply@example.invalid",
    to: toEmail,
    subject: mail.subject,
    html: mail.html,
  });
}

function parseAdminSignupBody(req) {
  const body = mergeFormBody(req);
  return {
    orgName: String(body.orgName || "").trim(),
    slug: String(body.slug || "").trim().toLowerCase(),
    siret: String(body.siret || "").trim(),
    address: String(body.address || "").trim(),
    phone: String(body.phone || "").trim(),
    orgEmail: String(body.orgEmail || "").trim().toLowerCase(),
    firstName: String(body.firstName || "").trim(),
    lastName: String(body.lastName || "").trim(),
    email: String(body.email || "").trim().toLowerCase(),
  };
}

function validateAdminSignupPayload(payload) {
  if (
    !payload.orgName ||
    !payload.slug ||
    !payload.siret ||
    !payload.address ||
    !payload.phone ||
    !payload.orgEmail ||
    !payload.firstName ||
    !payload.lastName ||
    !payload.email
  ) {
    return "Tous les champs obligatoires doivent etre remplis.";
  }
  if (!/^[a-z0-9-]{3,60}$/.test(payload.slug)) {
    return "Slug invalide (3-60 caracteres: lettres, chiffres, tirets).";
  }
  if (!/^\S+@\S+\.\S+$/.test(payload.email) || !/^\S+@\S+\.\S+$/.test(payload.orgEmail)) {
    return "Merci de saisir des e-mails valides.";
  }
  return null;
}

router.get("/login", (_req, res) => res.redirect(302, "/login?from=portal"));

router.get("/register-admin", (_req, res) => {
  return res.render("portal-register-admin", {
    error: null,
    success: null,
    otpStep: false,
    signupId: "",
    formData: {},
  });
});

router.post("/register-admin/request-otp", adminOtpLimiter, async (req, res) => {
  cleanupPendingAdminSignups();
  const payload = parseAdminSignupBody(req);
  const validationError = validateAdminSignupPayload(payload);
  if (validationError) {
    return res.status(400).render("portal-register-admin", {
      error: validationError,
      success: null,
      otpStep: false,
      signupId: "",
      formData: payload,
    });
  }

  const [existingOrg, existingSiret, existingUser] = await Promise.all([
    prisma.organization.findUnique({ where: { slug: payload.slug } }),
    prisma.organization.findUnique({ where: { siret: payload.siret } }),
    prisma.user.findFirst({ where: { email: { equals: payload.email, mode: "insensitive" } } }),
  ]);
  if (existingOrg || existingSiret || existingUser) {
    return res.status(400).render("portal-register-admin", {
      error: "Impossible de demarrer l'inscription: slug, SIRET ou e-mail deja utilise.",
      success: null,
      otpStep: false,
      signupId: "",
      formData: payload,
    });
  }

  const otp = generateOtpCode();
  const signupId = crypto.randomUUID();
  pendingAdminSignups.set(signupId, {
    payload,
    otpHash: hashOtp(payload.email, otp),
    expiresAt: Date.now() + ADMIN_OTP_TTL_MS,
  });

  try {
    await sendAdminOtpEmail(payload.email, payload.firstName, otp);
  } catch (err) {
    pendingAdminSignups.delete(signupId);
    return res.status(500).render("portal-register-admin", {
      error: `OTP non envoye: ${err.message}`,
      success: null,
      otpStep: false,
      signupId: "",
      formData: payload,
    });
  }

  return res.render("portal-register-admin", {
    error: null,
    success: "Code OTP envoye. Verifiez votre e-mail puis saisissez le code pour finaliser l'inscription.",
    otpStep: true,
    signupId,
    formData: payload,
  });
});

router.post("/register-admin/verify-otp", adminOtpLimiter, async (req, res) => {
  cleanupPendingAdminSignups();
  const body = mergeFormBody(req);
  const signupId = String(body.signupId || "").trim();
  const otp = String(body.otp || "").trim();
  const pending = pendingAdminSignups.get(signupId);
  if (!pending) {
    return res.status(400).render("portal-register-admin", {
      error: "Session OTP expirée ou introuvable. Recommencez l'inscription.",
      success: null,
      otpStep: false,
      signupId: "",
      formData: {},
    });
  }
  if (!otp || hashOtp(pending.payload.email, otp) !== pending.otpHash) {
    return res.status(400).render("portal-register-admin", {
      error: "Code OTP invalide.",
      success: null,
      otpStep: true,
      signupId,
      formData: pending.payload,
    });
  }

  const { payload } = pending;
  let authUid = null;
  const invite = await inviteStaffSupabaseUser(payload.email, { redirectPath: "/login" });
  if (!invite.ok) {
    return res.status(400).render("portal-register-admin", {
      error: `Compte Auth: ${invite.error}`,
      success: null,
      otpStep: true,
      signupId,
      formData: payload,
    });
  }
  authUid = invite.authUid;
  if (invite.alreadyExisted) {
    return res.status(400).render("portal-register-admin", {
      error: "Cet e-mail est deja associe a un compte Auth. Utilisez une autre adresse.",
      success: null,
      otpStep: true,
      signupId,
      formData: payload,
    });
  }

  try {
    await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: payload.orgName,
          slug: payload.slug || portalSlugifyText(payload.orgName),
          siret: payload.siret,
          address: payload.address,
          phone: payload.phone,
          email: payload.orgEmail,
          isPlatform: false,
        },
      });
      await tx.user.create({
        data: {
          email: payload.email,
          passwordHash: null,
          authUid,
          firstName: payload.firstName,
          lastName: payload.lastName,
          role: Role.ADMIN,
          organizationId: org.id,
        },
      });
    });
  } catch (error) {
    return res.status(400).render("portal-register-admin", {
      error: `Erreur inscription: ${error.message}`,
      success: null,
      otpStep: true,
      signupId,
      formData: payload,
    });
  } finally {
    pendingAdminSignups.delete(signupId);
  }

  return res.render("portal-register-admin", {
    error: null,
    success: "Compte administrateur cree. Consultez votre e-mail pour definir votre mot de passe, puis connectez-vous.",
    otpStep: false,
    signupId: "",
    formData: {},
  });
});

router.post("/login", portalLoginLimiter, async (req, res) => {
  const body = mergeFormBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const code = String(body.code || "");
  if (!email || (!password && !code)) {
    return res.redirect(302, "/login?from=portal&err=champs");
  }
  const result = await performUnifiedLogin(req, res, { email, password, code });
  if (!result.ok) {
    const q = new URLSearchParams({ from: "portal" });
    if (result.reason === "champs") q.set("err", "champs");
    else if (result.reason === "provision") q.set("err", "provision");
    else if (result.reason === "code_court") q.set("err", "code_court");
    else if (result.reason === "noprofile") q.set("err", "noprofile");
    else q.set("err", "auth");
    return res.redirect(302, `/login?${q.toString()}`);
  }
  return res.redirect(302, result.redirect);
});

router.post("/logout", async (req, res) => {
  try {
    const supabase = createSupabaseRouteClient(req, res);
    await supabase.auth.signOut();
  } catch (_) {
    /* ignore */
  }
  clearClientPortalCookie(res);
  return res.redirect("/login");
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
