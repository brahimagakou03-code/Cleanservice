const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { useSecureCookies } = require("./cookieFlags");

const ACCESS_COOKIE = "access_token";
const REFRESH_COOKIE = "refresh_token";
const CLIENT_PORTAL_COOKIE = "client_portal_token";

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/** Mot de passe provisoire portail client (lettres + chiffres, sans caractères ambigus). */
function generatePortalPassword(length = 14) {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      organizationId: user.organizationId,
      role: user.role,
      email: user.email,
    },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "15m" }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      organizationId: user.organizationId,
      role: user.role,
      type: "refresh",
    },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
}

function setAuthCookies(res, accessToken, refreshToken) {
  const secure = useSecureCookies();
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
  };
  res.cookie(ACCESS_COOKIE, accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
}

function clearAuthCookies(res) {
  const secure = useSecureCookies();
  const base = { path: "/", secure, sameSite: "lax" };
  res.clearCookie(ACCESS_COOKIE, base);
  res.clearCookie(REFRESH_COOKIE, base);
}

function signClientPortalToken(customer) {
  return jwt.sign(
    {
      sub: customer.id,
      organizationId: customer.organizationId,
      type: "client_portal",
      email: customer.email,
      companyName: customer.companyName,
    },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "2d" }
  );
}

function verifyClientPortalToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}

function setClientPortalCookie(res, token) {
  const secure = useSecureCookies();
  res.cookie(CLIENT_PORTAL_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 2 * 24 * 60 * 60 * 1000,
  });
}

function clearClientPortalCookie(res) {
  res.clearCookie(CLIENT_PORTAL_COOKIE, {
    path: "/",
    secure: useSecureCookies(),
    sameSite: "lax",
  });
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CLIENT_PORTAL_COOKIE,
  hashPassword,
  comparePassword,
  generatePortalPassword,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  setAuthCookies,
  clearAuthCookies,
  signClientPortalToken,
  verifyClientPortalToken,
  setClientPortalCookie,
  clearClientPortalCookie,
};
