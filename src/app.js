require("dotenv").config();
require("ejs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const csrf = require("csurf");
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
const { useSecureCookies } = require("./utils/cookieFlags");

const app = express();
app.set("trust proxy", true);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/public", express.static(path.join(process.cwd(), "public")));
app.use("/branding", express.static(path.join(process.cwd(), "public", "branding")));
app.use("/uploads", express.static(path.join(process.cwd(), "public", "uploads")));
app.use("/invoices", express.static(path.join(process.cwd(), "public", "invoices")));
app.use(express.urlencoded({ extended: true }));
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

const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookies(),
    path: "/",
  },
});
app.use(csrfProtection);
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  next();
});

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
