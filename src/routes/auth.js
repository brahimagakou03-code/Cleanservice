const express = require("express");
const rateLimit = require("express-rate-limit");
const { prisma } = require("../db");
const {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  hashPassword,
  comparePassword,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  setAuthCookies,
  clearAuthCookies,
} = require("../utils/auth");
const { Role } = require("../utils/rbac");
const { mergeFormBody } = require("../utils/mergeFormBody");

const router = express.Router();

/** Si session équipe valide, redirige vers /dashboard et retourne true. */
async function redirectIfStaffAuthenticated(req, res) {
  const accessToken = req.cookies[ACCESS_COOKIE];
  try {
    if (accessToken) {
      verifyAccessToken(accessToken);
      res.redirect("/dashboard");
      return true;
    }
  } catch (_) {
    /* jeton expiré ou invalide */
  }
  const refreshToken = req.cookies[REFRESH_COOKIE];
  if (!refreshToken) return false;
  try {
    const payload = verifyRefreshToken(refreshToken);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (user?.isActive) {
      res.redirect("/dashboard");
      return true;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Trop de tentatives de connexion. Reessayez dans 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/register", async (req, res) => {
  if (await redirectIfStaffAuthenticated(req, res)) return;
  return res.render("register");
});

router.post("/register", async (req, res) => {
  const body = mergeFormBody(req);
  const { orgName, slug, siret, address, phone, orgEmail, logo, email, password, firstName, lastName } = body;
  if (!orgName || !slug || !siret || !address || !phone || !orgEmail || !email || !password || !firstName || !lastName) {
    return res.status(400).send("Tous les champs obligatoires doivent etre remplis.");
  }

  const passwordHash = await hashPassword(password);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: orgName, slug, siret, address, phone, email: orgEmail, logo: logo || null },
      });
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          firstName,
          lastName,
          role: Role.OWNER,
          organizationId: org.id,
        },
      });
      return { org, user };
    });

    const accessToken = signAccessToken(created.user);
    const refreshToken = signRefreshToken(created.user);
    setAuthCookies(res, accessToken, refreshToken);
    return res.redirect("/dashboard");
  } catch (error) {
    return res.status(400).send(`Erreur inscription: ${error.message}`);
  }
});

router.get("/login", async (req, res) => {
  if (await redirectIfStaffAuthenticated(req, res)) return;
  const err = typeof req.query.err === "string" ? req.query.err : "";
  let loginAlert = null;
  if (err === "champs") {
    loginAlert =
      "Merci de remplir l’e-mail et le mot de passe. Si le problème persiste, rechargez la page (Ctrl+F5) puis réessayez.";
  }
  if (err === "auth") {
    loginAlert = "E-mail ou mot de passe incorrect.";
  }
  return res.render("login", { loginAlert });
});

router.post("/login", loginLimiter, async (req, res) => {
  const body = mergeFormBody(req);
  const { email, password } = body;
  if (!email || !password) {
    return res.redirect(302, "/login?err=champs");
  }

  const user = await prisma.user.findUnique({ where: { email }, include: { organization: true } });
  if (!user || !user.isActive) {
    return res.redirect(302, "/login?err=auth");
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    return res.redirect(302, "/login?err=auth");
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  setAuthCookies(res, accessToken, refreshToken);
  return res.redirect("/dashboard");
});

router.post("/logout", (req, res) => {
  clearAuthCookies(res);
  return res.redirect("/login");
});

module.exports = router;
