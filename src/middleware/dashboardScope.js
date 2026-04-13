/**
 * Siège Clean Service : accès métier franchisé interdit (données d’une autre org).
 * Franchisé : accès aux écrans « plateforme » interdit.
 */
function enforceDashboardNavScope(req, res, next) {
  const subPath = req.path.startsWith("/") ? req.path : `/${req.path}`;
  const isPlatformOrg = req.organization?.isPlatform === true;
  const isPlatformRoute = subPath === "/platform" || subPath.startsWith("/platform/");

  if (isPlatformOrg && !isPlatformRoute) {
    return res.redirect("/dashboard/platform");
  }
  if (!isPlatformOrg && isPlatformRoute) {
    return res.status(403).send("Accès réservé à l’administration Clean Service (siège).");
  }
  return next();
}

module.exports = { enforceDashboardNavScope };
