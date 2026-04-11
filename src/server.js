require("dotenv").config();
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const csrf = require("csurf");
const { prisma } = require("./db");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const apiRoutes = require("./routes/api");
const customerRoutes = require("./routes/customers");
const catalogRoutes = require("./routes/catalog");
const orderRoutes = require("./routes/orders");
const invoiceRoutes = require("./routes/invoices");
const portalRoutes = require("./routes/portal");
const { startInvoiceJobs } = require("./jobs/invoiceJobs");
const notificationRoutes = require("./routes/notifications");
const guideRoutes = require("./routes/guide");
const { startEmailQueueJob } = require("./jobs/emailQueueJob");
const { requireAuth, withTenantContext, requireApiAuth } = require("./middleware/auth");
const { loadDashboardLayout } = require("./middleware/dashboardLayout");
const { i18nFr } = require("./middleware/i18nFr");
const { earlyMultipartBeforeCsrf } = require("./middleware/earlyMultipartBeforeCsrf");

const app = express();

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
app.use(earlyMultipartBeforeCsrf);

const csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "lax", secure: false } });
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

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  await prisma.$connect();
  startInvoiceJobs();
  startEmailQueueJob();
  console.log(`Serveur demarre sur http://localhost:${port}`);
});
