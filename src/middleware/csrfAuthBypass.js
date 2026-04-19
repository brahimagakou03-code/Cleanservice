const csrf = require("csurf");
const { useSecureCookies } = require("../utils/cookieFlags");

/**
 * Sur Netlify / serverless, le cookie secret CSRF peut ne pas être renvoyé au POST
 * alors que Origin/Referer prouvent une soumission same-origin.
 * Pour les POST d’auth uniquement, on accepte ce cas (toujours avec rate limit sur /login).
 */
const AUTH_POST_PATHS = new Set([
  "/login",
  "/register",
  "/register/verify-otp",
  "/admin-test",
  "/logout",
  "/portal/login",
  "/portal/logout",
]);

const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookies(),
    path: "/",
  },
});

function hostnameFromUrl(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isSameSiteAuthPost(req) {
  if (req.method !== "POST") return false;
  if (!AUTH_POST_PATHS.has(req.path)) return false;
  const host = String(req.hostname || "").toLowerCase();
  if (!host) return false;
  const origin = req.get("origin");
  const referer = req.get("referer");
  if (origin) {
    const oh = hostnameFromUrl(origin);
    if (oh && oh === host) return true;
  }
  if (referer) {
    const rh = hostnameFromUrl(referer);
    if (rh && rh === host) return true;
  }
  return false;
}

function csrfWithLoginBypass(req, res, next) {
  if (isSameSiteAuthPost(req)) return next();
  return csrfProtection(req, res, next);
}

function attachCsrfToken(req, res, next) {
  try {
    res.locals.csrfToken = typeof req.csrfToken === "function" ? req.csrfToken() : "";
  } catch (e) {
    return next(e);
  }
  next();
}

module.exports = { csrfWithLoginBypass, attachCsrfToken };
