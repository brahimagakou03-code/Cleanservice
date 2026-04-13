const { prisma, requestContext } = require("../db");
const { createSupabaseRouteClient } = require("../utils/supabaseExpress");
const { resolveAppIdentity } = require("../utils/supabaseAuth");

async function requireAuth(req, res, next) {
  try {
    const supabase = createSupabaseRouteClient(req, res);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      return res.redirect("/login");
    }
    const identity = await resolveAppIdentity(data.user);
    if (!identity || identity.kind !== "staff") {
      if (identity?.kind === "portal") {
        return res.redirect("/portal");
      }
      return res.redirect("/login");
    }
    const u = identity.user;
    req.user = {
      sub: u.id,
      organizationId: u.organizationId,
      role: u.role,
      email: u.email,
    };
    return next();
  } catch (_) {
    return res.redirect("/login");
  }
}

async function withTenantContext(req, res, next) {
  if (!req.user?.organizationId) {
    return res.status(403).send("Session invalide : organisation manquante. Deconnectez-vous puis reconnectez-vous.");
  }

  try {
    const organization = await prisma.organization.findUnique({
      where: { id: req.user.organizationId },
    });
    req.organization = organization;
    if (!organization) {
      return res.status(403).send("Organisation introuvable.");
    }

    return requestContext.run(
      {
        organizationId: req.user.organizationId,
        userId: req.user.sub,
        role: req.user.role,
        isPlatformOrg: organization.isPlatform === true,
      },
      () => next()
    );
  } catch (e) {
    return next(e);
  }
}

function requireApiAuth(req, res, next) {
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    return withTenantContext(req, res, next);
  });
}

module.exports = { requireAuth, withTenantContext, requireApiAuth };
