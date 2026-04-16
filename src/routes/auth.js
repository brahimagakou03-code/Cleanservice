const express = require("express");
const rateLimit = require("express-rate-limit");
const { prisma } = require("../db");
const { clearAuthCookies, clearClientPortalCookie } = require("../utils/auth");
const { Role } = require("../utils/rbac");
const { mergeFormBody } = require("../utils/mergeFormBody");
const { createSupabaseRouteClient, isSupabaseAuthConfigured } = require("../utils/supabaseExpress");
const { resolveAppIdentity, ensureStaffSupabaseAuthUser } = require("../utils/supabaseAuth");
const { performUnifiedLogin } = require("../services/unifiedLogin");

const router = express.Router();

async function redirectIfAlreadyAuthenticated(req, res) {
  if (!isSupabaseAuthConfigured()) return false;
  try {
    const supabase = createSupabaseRouteClient(req, res);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return false;
    const identity = await resolveAppIdentity(data.user);
    if (identity?.kind === "staff") {
      const u = await prisma.user.findUnique({
        where: { id: identity.user.id },
        include: { organization: true },
      });
      let path = "/dashboard";
      if (u?.organization?.isPlatform === true && u.role === Role.PLATFORM_ADMIN) {
        path = "/dashboard/platform";
      }
      res.redirect(path);
      return true;
    }
    if (identity?.kind === "portal") {
      res.redirect("/portal");
      return true;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

function limiterKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const nfIp = String(req.headers["x-nf-client-connection-ip"] || "").trim();
  const socketIp = String(req.socket?.remoteAddress || "").trim();
  return forwarded || nfIp || req.ip || socketIp || "unknown";
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Trop de tentatives de connexion. Reessayez dans 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
  validate: false,
});

function isPrismaDbUnreachable(err) {
  const code = err?.code;
  const msg = String(err?.message || "");
  return code === "P1001" || msg.includes("Can't reach database server") || msg.includes("P1001");
}

function isUniqueConstraintError(err) {
  return String(err?.code || "") === "P2002";
}

router.get("/register", async (req, res) => {
  if (await redirectIfAlreadyAuthenticated(req, res)) return;
  const err = typeof req.query.err === "string" ? req.query.err : "";
  const ok = req.query.ok === "1";
  let registerAlert = null;
  let registerSuccess = null;
  if (ok) {
    registerSuccess = "Compte admin cree. Vous pouvez maintenant vous connecter avec votre e-mail et mot de passe.";
  } else if (err === "champs") {
    registerAlert = "Merci de remplir tous les champs obligatoires.";
  } else if (err === "password") {
    registerAlert = "Mot de passe trop court (minimum 6 caracteres).";
  } else if (err === "exist") {
    registerAlert = "Cet e-mail est deja utilise. Connectez-vous ou utilisez une autre adresse.";
  } else if (err === "auth") {
    registerAlert = "Creation du compte impossible cote authentification. Reessayez dans quelques instants.";
  } else if (err === "org") {
    registerAlert = "Aucune organisation n'est configuree pour rattacher ce compte administrateur.";
  } else if (err === "config") {
    registerAlert = "Configuration d'inscription incomplete. Verifiez les variables Supabase cote hebergeur.";
  } else if (err === "db") {
    registerAlert =
      "La base de donnees ne repond pas depuis l'hebergeur. Verifiez DATABASE_URL avec l'URI 'Transaction pooler' (port 6543) dans Supabase, puis redeployez.";
  }
  return res.render("register", { registerAlert, registerSuccess });
});

router.post("/register", async (req, res) => {
  const body = mergeFormBody(req);
  const firstName = String(body.firstName || "").trim();
  const lastName = String(body.lastName || "").trim();
  const emailNorm = String(body.email || "")
    .trim()
    .toLowerCase();
  const password = String(body.password || "");
  if (!firstName || !lastName || !emailNorm || !password) {
    return res.redirect(302, "/register?err=champs");
  }
  if (password.length < 6) {
    return res.redirect(302, "/register?err=password");
  }

  if (!isSupabaseAuthConfigured()) {
    return res.redirect(302, "/register?err=config");
  }

  const authUser = await ensureStaffSupabaseAuthUser(emailNorm, password);
  if (!authUser.ok) {
    if (String(authUser.error || "").includes("SUPABASE_SERVICE_ROLE_KEY")) {
      return res.redirect(302, "/register?err=config");
    }
    return res.redirect(302, "/register?err=auth");
  }

  try {
    const targetOrg =
      (await prisma.organization.findFirst({ where: { isPlatform: true }, select: { id: true } })) ||
      (await prisma.organization.findFirst({ select: { id: true } }));
    if (!targetOrg) {
      return res.redirect(302, "/register?err=org");
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          email: emailNorm,
          passwordHash: null,
          authUid: authUser.authUid,
          firstName,
          lastName,
          role: Role.ADMIN,
          organizationId: targetOrg.id,
        },
      });
    });
  } catch (error) {
    if (isPrismaDbUnreachable(error)) {
      return res.redirect(302, "/register?err=db");
    }
    if (isUniqueConstraintError(error)) {
      return res.redirect(302, "/register?err=exist");
    }
    return res.status(400).send(`Erreur inscription: ${error.message}`);
  }

  return res.redirect(302, "/register?ok=1");
});

router.get("/login", async (req, res) => {
  if (await redirectIfAlreadyAuthenticated(req, res)) return;
  const err = typeof req.query.err === "string" ? req.query.err : "";
  const from = typeof req.query.from === "string" ? req.query.from : "";
  let loginAlert = null;

  if (!isSupabaseAuthConfigured()) {
    loginAlert =
      "L’authentification nécessite Supabase : sur Netlify, ouvrez Site configuration → Environment variables et ajoutez SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (et DATABASE_URL pour la base). Les deux premières se trouvent dans Supabase → Project Settings → API. Enregistrez puis lancez un nouveau déploiement.";
  } else if (err === "config") {
    loginAlert =
      "Variables Supabase incomplètes ou invalides. Vérifiez SUPABASE_URL et SUPABASE_ANON_KEY sur l’hébergeur, puis redéployez.";
  } else if (err === "champs") {
    loginAlert =
      "Merci de remplir l’e-mail et le mot de passe. Si le problème persiste, rechargez la page (Ctrl+F5) puis réessayez.";
  } else if (err === "auth") {
    loginAlert = "E-mail ou mot de passe incorrect.";
  } else if (err === "noprofile") {
    loginAlert =
      "Aucun profil équipe ou client n’est lié à ce compte Supabase. Contactez votre administrateur ou utilisez l’e-mail enregistré chez votre fournisseur.";
  } else if (err === "provision") {
    loginAlert = "La migration du compte vers Supabase a échoué. Vérifiez SUPABASE_SERVICE_ROLE_KEY côté serveur.";
  } else if (err === "code_court") {
    loginAlert =
      "Identifiants portail trop courts (minimum 6 caractères côté Supabase). Utilisez le mot de passe reçu par e-mail.";
  } else if (err === "db") {
    loginAlert =
      "La base de données ne répond pas depuis Netlify. À faire : (1) Supabase → réveillez le projet s’il est en pause. (2) Netlify → Environment variables → DATABASE_URL : copiez l’URI « Transaction pooler » (port 6543) depuis Supabase → Connect → Connection strings (pas l’hôte db…:5432 seul). (3) Mot de passe avec @ # etc. : encodez-le dans l’URL (%40, %23…). (4) Redéployez le site après modification.";
  }
  return res.render("login", { loginAlert, fromPortal: from === "portal" });
});

router.post("/login", loginLimiter, async (req, res) => {
  const body = mergeFormBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const code = String(body.code || "");
  if (!email || (!password && !code)) {
    return res.redirect(302, "/login?err=champs");
  }

  const result = await performUnifiedLogin(req, res, { email, password, code });
  if (!result.ok) {
    if (result.reason === "champs") {
      return res.redirect(302, "/login?err=champs");
    }
    if (result.reason === "config") {
      return res.redirect(302, "/login?err=config");
    }
    if (result.reason === "provision") {
      return res.redirect(302, "/login?err=provision");
    }
    if (result.reason === "code_court") {
      return res.redirect(302, "/login?err=code_court");
    }
    if (result.reason === "noprofile") {
      return res.redirect(302, "/login?err=noprofile");
    }
    if (result.reason === "db") {
      return res.redirect(302, "/login?err=db");
    }
    return res.redirect(302, "/login?err=auth");
  }

  return res.redirect(302, result.redirect);
});

router.post("/logout", async (req, res) => {
  try {
    if (isSupabaseAuthConfigured()) {
      const supabase = createSupabaseRouteClient(req, res);
      await supabase.auth.signOut();
    }
  } catch (_) {
    /* ignore */
  }
  clearAuthCookies(res);
  clearClientPortalCookie(res);
  return res.redirect("/login");
});

module.exports = router;
