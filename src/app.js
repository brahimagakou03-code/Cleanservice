require("dotenv").config();
require("ejs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const apiRoutes = require("./routes/api");
const customerRoutes = require("./routes/customers");
const catalogRoutes = require("./routes/catalog");
const orderRoutes = require("./routes/orders");
const invoiceRoutes = require("./routes/invoices");
const portalRoutes = require("./routes/portal");
const notificationRoutes = require("./routes/notifications");
const guideRoutes = require("./routes/guide");
const { requireAuth, withTenantContext, requireApiAuth } = require("./middleware/auth");
const { enforceDashboardNavScope } = require("./middleware/dashboardScope");
const { loadDashboardLayout } = require("./middleware/dashboardLayout");
const { i18nFr } = require("./middleware/i18nFr");
const { earlyMultipartBeforeCsrf } = require("./middleware/earlyMultipartBeforeCsrf");
const { loadPlatformBranding } = require("./middleware/platformBranding");
const { csrfWithLoginBypass, attachCsrfToken } = require("./middleware/csrfAuthBypass");
const { netlifyEventFormBodyMerge } = require("./middleware/netlifyEventFormBody");

const app = express();
// Netlify place l'app derrière un proxy unique : "1" évite les erreurs express-rate-limit.
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/public", express.static(path.join(process.cwd(), "public")));
app.use("/branding", express.static(path.join(process.cwd(), "public", "branding")));
app.use("/uploads", express.static(path.join(process.cwd(), "public", "uploads")));
app.use("/invoices", express.static(path.join(process.cwd(), "public", "invoices")));
/**
 * POST formulaires : sur Netlify, Content-Type peut être absent ou exotique pour /admin/login, /super-admin/login, /register, /portal/login, /admin-test.
 * Pour ces routes, on force le parsing x-www-form-urlencoded (sauf multipart / json).
 */
function urlencodedTypeMatcher(req) {
  if (req.method !== "POST") return false;
  const p = req.path || "";
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("multipart/form-data")) return false;
  if (ct.includes("application/json")) return false;
  if (
    p === "/login" ||
    p === "/admin/login" ||
    p === "/super-admin/login" ||
    p === "/register" ||
    p === "/register/verify-otp" ||
    p === "/portal/login" ||
    /^\/dashboard\/customers\/[^/]+\/delete$/.test(p) ||
    /^\/dashboard\/customers\/[^/]+\/sites$/.test(p) ||
    /^\/dashboard\/customers\/[^/]+\/sites\/[^/]+\/(delete|update)$/.test(p) ||
    /^\/dashboard\/customers\/[^/]+\/prices$/.test(p) ||
    /^\/dashboard\/customers\/[^/]+\/prices\/[^/]+\/delete$/.test(p) ||
    /^\/dashboard\/customers\/[^/]+\/(general|portal-test-credentials|invite-portal)$/.test(p) ||
    /^\/dashboard\/platform\/organizations\/[^/]+\/name$/.test(p) ||
    p === "/dashboard/platform/shop-admins/create" ||
    p === "/dashboard/platform/auth-users/attach-shop-admin" ||
    /^\/dashboard\/platform\/shop-admins\/[^/]+\/delete$/.test(p) ||
    /^\/dashboard\/platform\/shop-admins\/[^/]+\/assign$/.test(p) ||
    /^\/dashboard\/platform\/users\/[^/]+\/role$/.test(p) ||
    /^\/dashboard\/platform\/users\/[^/]+\/assign-shop-admin$/.test(p) ||
    p === "/admin-test"
  )
    return true;
  if (ct.includes("application/x-www-form-urlencoded")) return true;
  if (!ct.trim()) return true;
  return false;
}

app.use(
  express.urlencoded({
    extended: true,
    type: urlencodedTypeMatcher,
    limit: "2mb",
    verify: (req, _res, buf) => {
      if (req.method !== "POST" || !buf || !buf.length) return;
      const p = req.path || "";
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      if (ct.includes("multipart/form-data") || ct.includes("application/json")) return;
      const authPost =
        p === "/login" ||
        p === "/admin/login" ||
        p === "/super-admin/login" ||
        p === "/register" ||
        p === "/register/verify-otp" ||
        p === "/portal/login" ||
        /^\/dashboard\/customers\/[^/]+\/delete$/.test(p) ||
        /^\/dashboard\/customers\/[^/]+\/sites$/.test(p) ||
        /^\/dashboard\/customers\/[^/]+\/sites\/[^/]+\/(delete|update)$/.test(p) ||
        /^\/dashboard\/customers\/[^/]+\/prices$/.test(p) ||
        /^\/dashboard\/customers\/[^/]+\/prices\/[^/]+\/delete$/.test(p) ||
        /^\/dashboard\/customers\/[^/]+\/(general|portal-test-credentials|invite-portal)$/.test(p) ||
        /^\/dashboard\/platform\/organizations\/[^/]+\/name$/.test(p) ||
        p === "/dashboard/platform/shop-admins/create" ||
        p === "/dashboard/platform/auth-users/attach-shop-admin" ||
        /^\/dashboard\/platform\/shop-admins\/[^/]+\/delete$/.test(p) ||
        /^\/dashboard\/platform\/shop-admins\/[^/]+\/assign$/.test(p) ||
        /^\/dashboard\/platform\/users\/[^/]+\/role$/.test(p) ||
        /^\/dashboard\/platform\/users\/[^/]+\/assign-shop-admin$/.test(p) ||
        p === "/admin-test";
      if (!authPost && !ct.includes("application/x-www-form-urlencoded") && ct.trim()) return;
      try {
        const raw = buf.toString("utf8");
        if (!raw.includes("=")) return;
        const flat = Object.fromEntries(new URLSearchParams(raw));
        if (Object.keys(flat).length) req._formBodyFallback = flat;
      } catch {
        /* ignore */
      }
    },
  }),
);
app.use(netlifyEventFormBodyMerge);
app.use(express.json());
app.use(cookieParser());
app.use(i18nFr);
app.use(loadPlatformBranding);
app.use(earlyMultipartBeforeCsrf);

/** Évite un HTML d'auth mis en cache sans le Set-Cookie CSRF (CDN / Netlify). */
app.use((req, res, next) => {
  const p = req.path || "";
  if (
    req.method === "GET" &&
    (p === "/" ||
      p === "/login" ||
      p === "/admin/login" ||
      p === "/super-admin/login" ||
      p === "/register" ||
      p === "/register/verify-otp" ||
      p === "/portal/login" ||
      p === "/admin-test")
  ) {
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});

app.use(csrfWithLoginBypass);
app.use(attachCsrfToken);

app.get("/", (_req, res) => res.render("choose-portal"));

/* Portail avant auth monté sur « / » : sinon /portal/* peut ne jamais atteindre ce routeur (Express 5). */
app.use("/portal", portalRoutes);
app.use("/", authRoutes);
const dashboardMw = [requireAuth, withTenantContext, enforceDashboardNavScope, loadDashboardLayout];
app.use("/dashboard", ...dashboardMw, dashboardRoutes);
app.use("/dashboard/customers", ...dashboardMw, customerRoutes);
app.use("/dashboard/catalog", ...dashboardMw, catalogRoutes);
app.use("/dashboard/orders", ...dashboardMw, orderRoutes);
app.use("/dashboard/invoices", ...dashboardMw, invoiceRoutes);
app.use("/dashboard/notifications", ...dashboardMw, notificationRoutes);
app.use("/dashboard/guide", ...dashboardMw, guideRoutes);
app.use("/api", requireApiAuth, apiRoutes);

function sameHostReferer(req) {
  const ref = req.get("referer");
  if (!ref) return "";
  try {
    const u = new URL(ref);
    const host = String(req.get("host") || "");
    if (!host || u.host !== host) return "";
    return `${u.pathname}${u.search || ""}`;
  } catch {
    return "";
  }
}

app.use((err, _req, res, _next) => {
  if (err.code === "EBADCSRFTOKEN") {
    const req = _req;
    const back = sameHostReferer(req);
    const fallback =
      req.path.startsWith("/dashboard/customers") || req.path.startsWith("/dashboard/")
        ? "/dashboard/customers?err=csrf"
        : req.path.startsWith("/portal/")
          ? "/portal/login?err=csrf"
          : "/login?err=csrf";
    const target = back
      ? `${back}${back.includes("?") ? "&" : "?"}err=csrf`
      : fallback;
    return res.redirect(302, target);
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).send(`Envoi de fichier : ${err.message}`);
  }
  if (
    typeof err.message === "string" &&
    /^(Images produit|Fiche fournisseur|Champ de fichier)/.test(err.message)
  ) {
    return res.status(400).send(err.message);
  }
  return res.status(500).send(`Erreur serveur: ${err.message}`);
});

module.exports = { app };
