/**
 * csurf lit req.body._csrf avant que multer ne parse le multipart : les formulaires
 * fichier (produit, import CSV) échouent avec « Token CSRF invalide ».
 * Ce middleware parse le multipart en premier sur les routes concernées.
 */
const fs = require("node:fs");
const path = require("node:path");
const multer = require("multer");

const isServerless =
  Boolean(process.env.NETLIFY) ||
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
  Boolean(process.env.VERCEL);
const uploadDir = isServerless
  ? path.join(require("node:os").tmpdir(), "clean-service-uploads")
  : path.join(process.cwd(), "public", "uploads");
try {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
} catch {
  /* FS en lecture seule sur certaines plateformes serverless */
}

const productImageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${String(file.originalname).replace(/\s+/g, "-")}`),
});

const PRODUCT_CATALOG_FIELDS = [
  { name: "images", maxCount: 5 },
  { name: "supplierSheetPdf", maxCount: 1 },
  { name: "technicalSheetPdf", maxCount: 1 },
];

const productCatalogUpload = multer({
  storage: productImageStorage,
  limits: { files: 10, fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === "images") {
      if (!file.mimetype || !file.mimetype.startsWith("image/")) {
        return cb(new Error("Images produit : fichiers image uniquement (JPG, PNG, WebP…)."));
      }
      return cb(null, true);
    }
    if (file.fieldname === "supplierSheetPdf" || file.fieldname === "technicalSheetPdf") {
      const name = String(file.originalname || "");
      const mime = String(file.mimetype || "");
      const isPdf =
        mime === "application/pdf" ||
        mime === "application/x-pdf" ||
        (mime === "application/octet-stream" && /\.pdf$/i.test(name)) ||
        /\.pdf$/i.test(name);
      if (!isPdf) return cb(new Error("Fiche fournisseur / fiche technique : uniquement des fichiers PDF."));
      return cb(null, true);
    }
    return cb(new Error("Champ de fichier non reconnu."));
  },
}).fields(PRODUCT_CATALOG_FIELDS);

const importMemoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const RESERVED_CATALOG_SEGMENTS = new Set(["categories", "import", "export", "new"]);

function isMultipart(req) {
  return String(req.headers["content-type"] || "").toLowerCase().includes("multipart/form-data");
}

function pathnameNorm(req) {
  const p = req.path || "/";
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function earlyMultipartBeforeCsrf(req, res, next) {
  if (req.method !== "POST" || !isMultipart(req)) return next();

  const pathname = pathnameNorm(req);

  if (pathname === "/dashboard/catalog/import/preview") {
    return importMemoryUpload.single("file")(req, res, (err) => (err ? next(err) : next()));
  }
  if (pathname === "/dashboard/customers/import/preview") {
    return importMemoryUpload.single("file")(req, res, (err) => (err ? next(err) : next()));
  }

  let isProductPost = pathname === "/dashboard/catalog";
  if (!isProductPost) {
    const m = pathname.match(/^\/dashboard\/catalog\/([^/]+)$/);
    if (m && !RESERVED_CATALOG_SEGMENTS.has(m[1])) isProductPost = true;
  }
  if (isProductPost) {
    return productCatalogUpload(req, res, (err) => (err ? next(err) : next()));
  }

  return next();
}

/** Route catalogue : multipart déjà parsé par earlyMultipartBeforeCsrf. */
function ensureCatalogProductImages(req, res, next) {
  if (req.files && typeof req.files === "object" && !Array.isArray(req.files)) return next();
  return productCatalogUpload(req, res, next);
}

/** Prévisualisation import CSV (fichier déjà parsé si early a tourné). */
function ensureImportCsvFile(req, res, next) {
  if (req.file) return next();
  return importMemoryUpload.single("file")(req, res, next);
}

module.exports = {
  earlyMultipartBeforeCsrf,
  ensureCatalogProductImages,
  ensureImportCsvFile,
};
