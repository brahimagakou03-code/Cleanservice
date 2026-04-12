const { prisma } = require("../db");

const DEFAULT_LOGO = "/branding/logo.png";

async function loadPlatformBranding(_req, res, next) {
  res.locals.platformLogoUrl = DEFAULT_LOGO;
  res.locals.platformFaviconHref = null;
  try {
    const row = await prisma.platformBranding.findUnique({ where: { id: "site" } });
    if (row?.logoDataUrl) res.locals.platformLogoUrl = row.logoDataUrl;
    if (row?.faviconDataUrl) res.locals.platformFaviconHref = row.faviconDataUrl;
  } catch {
    /* table absente avant migration */
  }
  next();
}

module.exports = { loadPlatformBranding, DEFAULT_LOGO };
