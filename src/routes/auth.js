const express = require("express");
const rateLimit = require("express-rate-limit");
const { prisma } = require("../db");
const { clearAuthCookies, clearClientPortalCookie } = require("../utils/auth");
const { Role } = require("../utils/rbac");
const { mergeFormBody } = require("../utils/mergeFormBody");
const { createSupabaseRouteClient } = require("../utils/supabaseExpress");
const { createSupabaseServiceClient } = require("../lib/supabase");
const { resolveAppIdentity } = require("../utils/supabaseAuth");
const { performUnifiedLogin } = require("../services/unifiedLogin");

const router = express.Router();

async function redirectIfAlreadyAuthenticated(req, res) {
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

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Trop de tentatives de connexion. Reessayez dans 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/register", async (req, res) => {
  if (await redirectIfAlreadyAuthenticated(req, res)) return;
  return res.render("register");
});

router.post("/register", async (req, res) => {
  const body = mergeFormBody(req);
  const { orgName, slug, siret, address, phone, orgEmail, logo, email, password, firstName, lastName } = body;
  if (!orgName || !slug || !siret || !address || !phone || !orgEmail || !email || !password || !firstName || !lastName) {
    return res.status(400).send("Tous les champs obligatoires doivent etre remplis.");
  }

  const svc = createSupabaseServiceClient();
  if (!svc) {
    return res
      .status(503)
      .send("Inscription indisponible : configurez SUPABASE_URL, SUPABASE_ANON_KEY et SUPABASE_SERVICE_ROLE_KEY.");
  }

  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email: String(email).trim().toLowerCase(),
    password: String(password),
    email_confirm: true,
  });
  if (authErr || !authData?.user?.id) {
    return res.status(400).send(`Compte Auth : ${authErr?.message || "creation impossible"}`);
  }

  const authUid = authData.user.id;

  try {
    await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: orgName,
          slug,
          siret,
          address,
          phone,
          email: orgEmail,
          logo: logo || null,
          isPlatform: false,
        },
      });
      await tx.user.create({
        data: {
          email: String(email).trim().toLowerCase(),
          passwordHash: null,
          authUid,
          firstName,
          lastName,
          role: Role.OWNER,
          organizationId: org.id,
        },
      });
    });
  } catch (error) {
    try {
      await svc.auth.admin.deleteUser(authUid);
    } catch (_) {
      /* ignore */
    }
    return res.status(400).send(`Erreur inscription: ${error.message}`);
  }

  try {
    const supabase = createSupabaseRouteClient(req, res);
    const { error: signErr } = await supabase.auth.signInWithPassword({
      email: String(email).trim().toLowerCase(),
      password: String(password),
    });
    if (signErr) {
      return res
        .status(201)
        .send(
          "Organisation creee. La session automatique a echoue : connectez-vous sur la page de connexion avec le meme e-mail et mot de passe."
        );
    }
  } catch (e) {
    return res.status(201).send(`Organisation creee mais connexion automatique impossible : ${e.message}`);
  }

  return res.redirect("/dashboard");
});

router.get("/login", async (req, res) => {
  if (await redirectIfAlreadyAuthenticated(req, res)) return;
  const err = typeof req.query.err === "string" ? req.query.err : "";
  const from = typeof req.query.from === "string" ? req.query.from : "";
  let loginAlert = null;
  if (err === "champs") {
    loginAlert =
      "Merci de remplir l’e-mail et le mot de passe. Si le problème persiste, rechargez la page (Ctrl+F5) puis réessayez.";
  }
  if (err === "auth") {
    loginAlert = "E-mail ou mot de passe incorrect.";
  }
  if (err === "noprofile") {
    loginAlert =
      "Aucun profil équipe ou client n’est lié à ce compte Supabase. Contactez votre administrateur ou utilisez l’e-mail enregistré chez votre fournisseur.";
  }
  if (err === "provision") {
    loginAlert = "La migration du compte vers Supabase a échoué. Vérifiez SUPABASE_SERVICE_ROLE_KEY côté serveur.";
  }
  if (err === "code_court") {
    loginAlert =
      "Identifiants portail trop courts (minimum 6 caractères côté Supabase). Utilisez le mot de passe reçu par e-mail.";
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
      return res.status(503).send(result.message || "Supabase non configure.");
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
    return res.redirect(302, "/login?err=auth");
  }

  return res.redirect(302, result.redirect);
});

router.post("/logout", async (req, res) => {
  try {
    const supabase = createSupabaseRouteClient(req, res);
    await supabase.auth.signOut();
  } catch (_) {
    /* ignore */
  }
  clearAuthCookies(res);
  clearClientPortalCookie(res);
  return res.redirect("/login");
});

module.exports = router;
