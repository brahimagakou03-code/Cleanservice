const express = require("express");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const { prisma } = require("../db");
const { clearAuthCookies, clearClientPortalCookie } = require("../utils/auth");
const { Role } = require("../utils/rbac");
const { mergeFormBody } = require("../utils/mergeFormBody");
const { createSupabaseRouteClient, isSupabaseAuthConfigured } = require("../utils/supabaseExpress");
const { resolveAppIdentity, ensureStaffSupabaseAuthUser } = require("../utils/supabaseAuth");
const { performUnifiedLogin } = require("../services/unifiedLogin");

const router = express.Router();
const MAX_ADMIN_TEST_LOGS = 300;
const adminTestLogs = [];

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

function pushAdminTestLog(entry) {
  adminTestLogs.unshift({
    at: new Date(),
    ip: entry.ip || "",
    email: entry.email || "",
    status: entry.status || "ERROR",
    reason: entry.reason || "",
    role: entry.role || "",
    organization: entry.organization || "",
    redirect: entry.redirect || "",
    jwt: entry.jwt || "",
    steps: Array.isArray(entry.steps) ? entry.steps : [],
    stepsSummary: entry.stepsSummary || "",
    details: entry.details || "",
    missing: entry.missing || "",
    action: entry.action || "",
  });
  if (adminTestLogs.length > MAX_ADMIN_TEST_LOGS) {
    adminTestLogs.length = MAX_ADMIN_TEST_LOGS;
  }
}

function makeAuthStep(label, status, why) {
  return { label, status, why: why || "" };
}

function summarizeAuthSteps(steps) {
  return (steps || [])
    .map((s) => `${s.label}: ${s.status}${s.why ? ` (${s.why})` : ""}`)
    .join(" | ");
}

function buildAuthSteps({ reason, email, password, preview, jwtCheck }) {
  const r = String(reason || "auth");
  const hasEmail = Boolean(String(email || "").trim());
  const hasPassword = Boolean(String(password || ""));
  const credentialsOk = hasEmail && hasPassword;
  const configOk = isSupabaseAuthConfigured();
  const profileKnown = Boolean(preview);
  const loginOk = r === "success";
  const jwtOk = loginOk && jwtCheck?.jwt === "OK";

  return [
    makeAuthStep(
      "1. Champs formulaire",
      credentialsOk ? "OK" : "KO",
      credentialsOk ? "" : "Email ou mot de passe manquant."
    ),
    makeAuthStep(
      "2. Config Supabase",
      configOk ? "OK" : "KO",
      configOk ? "" : "SUPABASE_URL / SUPABASE_ANON_KEY manquants ou invalides."
    ),
    makeAuthStep(
      "3. Profil interne",
      profileKnown ? "OK" : "KO",
      profileKnown ? "" : "Aucun profil staff connu pour cet e-mail."
    ),
    makeAuthStep(
      "4. Login Supabase",
      loginOk ? "OK" : "KO",
      loginOk
        ? ""
        : r === "auth"
          ? "Identifiants invalides ou compte non reconnu."
          : r === "db"
            ? "Base de donnees injoignable pendant la tentative."
            : r === "config"
              ? "Client Supabase non initialisable."
              : r === "provision"
                ? "Provision du compte Auth impossible."
                : r === "noprofile"
                  ? "Compte Auth valide mais non lie a un profil metier."
                  : `Echec de type ${r}.`
    ),
    makeAuthStep(
      "5. JWT session",
      loginOk ? (jwtOk ? "OK" : "KO") : "N/A",
      loginOk ? (jwtOk ? "" : jwtCheck?.jwtDetails || "JWT absent ou invalide.") : "Non teste (connexion echouee)."
    ),
  ];
}

function diagnoseAdminTestFailure(reason, message, preview) {
  const r = String(reason || "auth");
  const m = String(message || "");
  if (r === "champs") {
    return {
      details: "Le formulaire est incomplet.",
      missing: "Email et/ou mot de passe manquant.",
      action: "Renseigner les deux champs puis relancer le test.",
    };
  }
  if (r === "config") {
    return {
      details: "La configuration Supabase est invalide ou incomplète.",
      missing: "SUPABASE_URL et/ou SUPABASE_ANON_KEY.",
      action: "Corriger les variables d'environnement sur l'hebergeur puis redeployer.",
    };
  }
  if (r === "db") {
    return {
      details: m || "La base ne repond pas.",
      missing: "Connexion DB joignable (DATABASE_URL).",
      action: "Utiliser l'URI Transaction pooler:6543, verifier le mot de passe encode et redeployer.",
    };
  }
  if (r === "noprofile") {
    return {
      details: "Le compte Supabase existe mais n'est lie a aucun profil metier.",
      missing: "Profil staff/client rattache a cet e-mail.",
      action: "Creer/associer un profil dans la base avec authUid et le bon e-mail.",
    };
  }
  if (r === "provision") {
    return {
      details: m || "La provision du compte Auth a echoue.",
      missing: "Permissions admin Supabase (service role).",
      action: "Verifier SUPABASE_SERVICE_ROLE_KEY et les droits Auth admin.",
    };
  }
  if (r === "auth") {
    return {
      details: "Identifiants invalides ou compte non reconnu.",
      missing: preview ? "" : "Profil utilisateur introuvable pour cet e-mail.",
      action: "Verifier e-mail/mot de passe. Si besoin, reinitialiser le mot de passe.",
    };
  }
  return {
    details: m || `Echec de connexion (${r}).`,
    missing: "",
    action: "Verifier la configuration puis retester.",
  };
}

async function resolveIdentityPreviewByEmail(email) {
  const emailNorm = String(email || "")
    .trim()
    .toLowerCase();
  if (!emailNorm) return null;
  const user = await prisma.user.findFirst({
    where: { email: { equals: emailNorm, mode: "insensitive" } },
    include: { organization: true },
  });
  if (!user) return null;
  return {
    role: user.role,
    organization: user.organization?.name || "",
  };
}

function getRequestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const nfIp = String(req.headers["x-nf-client-connection-ip"] || "").trim();
  const socketIp = String(req.socket?.remoteAddress || "").trim();
  return forwarded || nfIp || req.ip || socketIp || "unknown";
}

/**
 * Après connexion Supabase : lit la session côté serveur et contrôle le JWT d'accès (présence + exp).
 * Ce n'est pas le cookie applicatif access_token (non utilisé aujourd'hui) : c'est le jeton Supabase Auth.
 */
async function summarizeSupabaseAccessJwtAfterLogin(req, res) {
  try {
    const supabase = createSupabaseRouteClient(req, res);
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      return {
        jwt: "KO",
        jwtDetails: `Session Supabase illisible : ${error.message || "erreur inconnue"}.`,
      };
    }
    const token = data?.session?.access_token;
    if (!token) {
      return {
        jwt: "KO",
        jwtDetails: "Aucun access_token dans la session Supabase (cookies de session non posés ou session vide).",
      };
    }
    const parts = String(token).split(".");
    if (parts.length !== 3) {
      return { jwt: "KO", jwtDetails: "Jeton recu mais format JWT invalide (segments != 3)." };
    }
    const decoded = jwt.decode(token, { complete: false });
    if (!decoded || typeof decoded !== "object") {
      return { jwt: "KO", jwtDetails: "Jeton JWT illisible (decode impossible)." };
    }
    const expSec = typeof decoded.exp === "number" ? decoded.exp : null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (expSec != null && expSec <= nowSec) {
      return {
        jwt: "KO",
        jwtDetails: `JWT Supabase expire (exp=${expSec}, maintenant=${nowSec}).`,
      };
    }
    const sub = typeof decoded.sub === "string" ? decoded.sub : "";
    const role = typeof decoded.role === "string" ? decoded.role : "";
    const aud = typeof decoded.aud === "string" ? decoded.aud : "";
    const iss = typeof decoded.iss === "string" ? decoded.iss : "";
    const expHuman =
      expSec != null
        ? new Date(expSec * 1000).toLocaleString("fr-FR", { timeZone: "UTC" }) + " UTC"
        : "inconnue";
    const bits = [
      `exp=${expHuman}`,
      sub ? `sub=${sub}` : "",
      role ? `role_claim=${role}` : "",
      aud ? `aud=${aud}` : "",
      iss ? `iss=${iss}` : "",
    ].filter(Boolean);
    return { jwt: "OK", jwtDetails: `JWT Supabase present et non expire (${bits.join(" ; ")}).` };
  } catch (e) {
    return {
      jwt: "KO",
      jwtDetails: `Erreur lors de la lecture du JWT Supabase : ${e?.message || String(e)}`,
    };
  }
}

router.get("/admin-test", async (_req, res) => {
  return res.render("admin-test", {
    logs: adminTestLogs,
    testResult: null,
    testAlert: null,
  });
});

router.post("/admin-test", loginLimiter, async (req, res) => {
  const body = mergeFormBody(req);
  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  const password = String(body.password || "");
  const ip = getRequestIp(req);

  if (!email || !password) {
    const alert = "Merci de remplir l'e-mail et le mot de passe.";
    const diag = diagnoseAdminTestFailure("champs", "", null);
    const steps = buildAuthSteps({ reason: "champs", email, password, preview: null, jwtCheck: null });
    pushAdminTestLog({
      ip,
      email,
      status: "ERROR",
      reason: "champs",
      steps,
      stepsSummary: summarizeAuthSteps(steps),
      details: diag.details,
      missing: diag.missing,
      action: diag.action,
    });
    return res.status(400).render("admin-test", {
      logs: adminTestLogs,
      testResult: {
        ok: false,
        message: "Connexion echouee.",
        redirect: "",
        role: "inconnu",
        organization: "inconnue",
        jwt: "N/A",
        jwtDetails: "JWT non verifie car les champs sont incomplets.",
        steps,
      },
      testAlert: alert,
    });
  }

  const result = await performUnifiedLogin(req, res, { email, password, code: "" });
  if (!result.ok) {
    const preview = await resolveIdentityPreviewByEmail(email);
    const diag = diagnoseAdminTestFailure(result.reason, result.message, preview);
    const steps = buildAuthSteps({
      reason: result.reason || "auth",
      email,
      password,
      preview,
      jwtCheck: null,
    });
    pushAdminTestLog({
      ip,
      email,
      status: "ERROR",
      reason: result.reason || "auth",
      role: preview?.role || "",
      organization: preview?.organization || "",
      steps,
      stepsSummary: summarizeAuthSteps(steps),
      details: diag.details,
      missing: diag.missing,
      action: diag.action,
    });
    return res.status(401).render("admin-test", {
      logs: adminTestLogs,
      testResult: {
        ok: false,
        message: "Connexion echouee.",
        redirect: "",
        role: preview?.role || "inconnu",
        organization: preview?.organization || "inconnue",
        jwt: "N/A",
        jwtDetails: "JWT non verifie car la connexion n'a pas abouti.",
        steps,
      },
      testAlert: `Connexion echouee (${result.reason || "auth"}). ${diag.details}`,
    });
  }

  const preview = await resolveIdentityPreviewByEmail(email);
  const jwtCheck = await summarizeSupabaseAccessJwtAfterLogin(req, res);
  const steps = buildAuthSteps({ reason: "success", email, password, preview, jwtCheck });
  pushAdminTestLog({
    ip,
    email,
    status: "OK",
    reason: "success",
    role: preview?.role || "",
    organization: preview?.organization || "",
    redirect: result.redirect || "",
    jwt: jwtCheck.jwt || "",
    steps,
    stepsSummary: summarizeAuthSteps(steps),
    details:
      jwtCheck.jwt === "OK"
        ? `Connexion admin validee. ${jwtCheck.jwtDetails || ""}`
        : `Connexion admin validee, mais controle JWT KO : ${jwtCheck.jwtDetails || ""}`,
    missing: jwtCheck.jwt === "OK" ? "" : "Session Supabase / JWT access_token.",
    action:
      jwtCheck.jwt === "OK"
        ? "Aucune action requise."
        : "Verifier les cookies (domaine, HTTPS, SameSite), puis redeployer si besoin.",
  });
  return res.render("admin-test", {
    logs: adminTestLogs,
    testAlert: null,
    testResult: {
      ok: true,
      message: "Connexion reussie.",
      redirect: result.redirect || "",
      role: preview?.role || "inconnu",
      organization: preview?.organization || "inconnue",
      jwt: jwtCheck.jwt || "",
      jwtDetails: jwtCheck.jwtDetails || "",
      steps,
    },
  });
});

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
