const { prisma, requestContext } = require("../db");
const {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  verifyAccessToken,
  verifyRefreshToken,
  signAccessToken,
  signRefreshToken,
  setAuthCookies,
} = require("../utils/auth");

async function requireAuth(req, res, next) {
  const accessToken = req.cookies[ACCESS_COOKIE];
  const refreshToken = req.cookies[REFRESH_COOKIE];

  try {
    if (accessToken) {
      req.user = verifyAccessToken(accessToken);
      return next();
    }
  } catch (_) {}

  if (!refreshToken) {
    return res.redirect("/login");
  }

  try {
    const payload = verifyRefreshToken(refreshToken);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      return res.redirect("/login");
    }

    const newAccess = signAccessToken(user);
    const newRefresh = signRefreshToken(user);
    setAuthCookies(res, newAccess, newRefresh);
    req.user = verifyAccessToken(newAccess);
    return next();
  } catch (_) {
    return res.redirect("/login");
  }
}

function withTenantContext(req, res, next) {
  if (!req.user?.organizationId) {
    return res.status(403).send("Session invalide : organisation manquante. Deconnectez-vous puis reconnectez-vous.");
  }

  return requestContext.run(
    { organizationId: req.user.organizationId, userId: req.user.sub, role: req.user.role },
    () => next()
  );
}

function requireApiAuth(req, res, next) {
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    return withTenantContext(req, res, next);
  });
}

module.exports = { requireAuth, withTenantContext, requireApiAuth };
