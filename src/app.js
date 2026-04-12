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
const { loadDashboardLayout } = require("./middleware/dashboardLayout");
const { i18nFr } = require("./middleware/i18nFr");
const { earlyMultipartBeforeCsrf } = require("./middleware/earlyMultipartBeforeCsrf");
const { loadPlatformBranding } = require("./middleware/platformBranding");
const { csrfWithLoginBypass, attachCsrfToken } = require("./middleware/csrfAuthBypass");
const { netlifyEventFormBodyMerge } = require("./middleware/netlifyEventFormBody");

const app = express();
app.set("trust proxy", true);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/public", express.static(path.join(process.cwd(), "public")));
app.use("/branding", express.static(path.join(process.cwd(), "public", "branding")));
app.use("/uploads", express.static(path.join(process.cwd(), "public", "uploads")));
app.use("/invoices", express.static(path.join(process.cwd(), "public", "invoices")));
/**
 * POST formulaires : sur Netlify, Content-Type peut être absent ou exotique pour /login, /register, /portal/login.
 * Pour ces routes, on force le parsing x-www-form-urlencoded (sauf multipart / json).
 */
function urlencodedTypeMatcher(req) {
  if (req.method !== "POST") return false;
  const p = req.path || "";
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("multipart/form-data")) return false;
  if (ct.includes("application/json")) return false;
  if (p === "/login" || p === "/register" || p === "/portal/login") return true;
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
      const authPost = p === "/login" || p === "/register" || p === "/portal/login";
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

/** Évite un HTML /login mis en cache sans le Set-Cookie CSRF (CDN / Netlify). */
app.use((req, res, next) => {
  const p = req.path || "";
  if (req.method === "GET" && (p === "/" || p === "/login" || p === "/register" || p === "/portal/login")) {
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
const dashboardMw = [requireAuth, withTenantContext, loadDashboardLayout];
app.use("/dashboard", ...dashboardMw, dashboardRoutes);
app.use("/dashboard/customers", ...dashboardMw, customerRoutes);
app.use("/dashboard/catalog", ...dashboardMw, catalogRoutes);
app.use("/dashboard/orders", ...dashboardMw, orderRoutes);
app.use("/dashboard/invoices", ...dashboardMw, invoiceRoutes);
app.use("/dashboard/notifications", ...dashboardMw, notificationRoutes);
app.use("/dashboard/guide", ...dashboardMw, guideRoutes);
app.use("/api", requireApiAuth, apiRoutes);

app.use((err, _req, res, _next) => {
  if (err.code === "EBADCSRFTOKEN") {
    return res.status(403).send("Token CSRF invalide.");
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
