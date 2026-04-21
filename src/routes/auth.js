const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");
const jwt = require("jsonwebtoken");
const { prisma } = require("../db");
const { clearAuthCookies, clearClientPortalCookie } = require("../utils/auth");
const { Role } = require("../utils/rbac");
const { mergeFormBody } = require("../utils/mergeFormBody");
const { createSupabaseRouteClient, isSupabaseAuthConfigured } = require("../utils/supabaseExpress");
const { resolveAppAccessProfiles, ensureStaffSupabaseAuthUser } = require("../utils/supabaseAuth");
const { performUnifiedLogin } = require("../services/unifiedLogin");

const router = express.Router();
const MAX_ADMIN_TEST_LOGS = 300;
const adminTestLogs = [];

async function redirectIfAlreadyAuthenticated(req, res, targetPortal = "auto") {
  if (!isSupabaseAuthConfigured()) return false;
  try {
    const supabase = createSupabaseRouteClient(req, res);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return false;
    const access = await resolveAppAccessProfiles(data.user);
    const target = String(targetPortal || "auto");
    const canSuperAdmin =
      Boolean(access.staff) &&
      access.staff.organization?.isPlatform === true &&
      access.staff.role === Role.PLATFORM_ADMIN;
    const canAdmin = Boolean(access.staff);
    const canClient = Boolean(access.customer);
    if (target === "superadmin" && canSuperAdmin) return res.redirect("/dashboard/platform"), true;
    if (target === "admin" && canAdmin) return res.redirect("/dashboard"), true;
    if (target === "client" && canClient) return res.redirect("/portal"), true;
    if (target === "auto") {
      if (canSuperAdmin) return res.redirect("/dashboard/platform"), true;
      if (canAdmin) return res.redirect("/dashboard"), true;
      if (canClient) return res.redirect("/portal"), true;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

function loginAlertFromErr(err) {
  if (!isSupabaseAuthConfigured()) {
    return "L’authentification nécessite Supabase : sur Netlify, ouvrez Site configuration → Environment variables et ajoutez SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (et DATABASE_URL pour la base). Les deux premières se trouvent dans Supabase → Project Settings → API. Enregistrez puis lancez un nouveau déploiement.";
  }
  if (err === "config") {
    return "Variables Supabase incomplètes ou invalides. Vérifiez SUPABASE_URL et SUPABASE_ANON_KEY sur l’hébergeur, puis redéployez.";
  }
  if (err === "champs") {
    return "Merci de remplir l’e-mail et le mot de passe. Si le problème persiste, rechargez la page (Ctrl+F5) puis réessayez.";
  }
  if (err === "auth") return "E-mail ou mot de passe incorrect.";
  if (err === "noprofile") {
    return "Aucun profil équipe ou client n’est lié à ce compte Supabase. Contactez votre administrateur ou utilisez l’e-mail enregistré chez votre fournisseur.";
  }
  if (err === "forbidden_portal") {
    return "Ce compte est actif, mais n'a pas les droits pour ce portail. Utilisez l'URL d'un portail autorisé.";
  }
  if (err === "provision") {
    return "La migration du compte vers Supabase a échoué. Vérifiez SUPABASE_SERVICE_ROLE_KEY côté serveur.";
  }
  if (err === "code_court") {
    return "Identifiants portail trop courts (minimum 6 caractères côté Supabase). Utilisez le mot de passe reçu par e-mail.";
  }
  if (err === "db") {
    return "La base de données ne répond pas depuis Netlify. À faire : (1) Supabase → réveillez le projet s’il est en pause. (2) Netlify → Environment variables → DATABASE_URL : copiez l’URI « Transaction pooler » (port 6543) depuis Supabase → Connect → Connection strings (pas l’hôte db…:5432 seul). (3) Mot de passe avec @ # etc. : encodez-le dans l’URL (%40, %23…). (4) Redéployez le site après modification.";
  }
  return null;
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

const ADMIN_REGISTER_OTP_TTL_MS = 10 * 60 * 1000;
const pendingStaffRegisterSignups = new Map();

const registerOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Trop de demandes OTP. Reessayez dans 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
  validate: false,
});

function htmlEscape(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 999999));
}

function hashRegisterOtp(email, otp) {
  return crypto
    .createHash("sha256")
    .update(`${String(email || "").trim().toLowerCase()}::${String(otp || "").trim()}`)
    .digest("hex");
}

function cleanupPendingStaffRegisterSignups() {
  const now = Date.now();
  for (const [id, entry] of pendingStaffRegisterSignups.entries()) {
    if (!entry || entry.expiresAt <= now) pendingStaffRegisterSignups.delete(id);
  }
}

function staffRegisterOtpTemplate({ firstName, otp, expiresMinutes }) {
  const safeFirstName = htmlEscape(firstName || "Admin");
  const safeOtp = htmlEscape(otp);
  return {
    subject: "Code OTP inscription administrateur",
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;">
      <h2>Inscription administrateur</h2>
      <p>Bonjour ${safeFirstName},</p>
      <p>Votre code OTP est :</p>
      <p style="font-size:28px;letter-spacing:4px;font-weight:700;background:#f3f5f8;padding:12px 16px;border-radius:8px;display:inline-block;">${safeOtp}</p>
      <p>Ce code expire dans ${expiresMinutes} minutes.</p>
      <p>Si vous n'etes pas a l'origine de cette demande, ignorez cet e-mail.</p>
    </div>`,
  };
}

async function sendStaffRegisterOtpEmail(toEmail, firstName, otp) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "127.0.0.1",
    port: Number(process.env.SMTP_PORT || 1025),
    secure: false,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
  });
  const mail = staffRegisterOtpTemplate({
    firstName,
    otp,
    expiresMinutes: Math.round(ADMIN_REGISTER_OTP_TTL_MS / 60000),
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || "no-reply@example.invalid",
    to: toEmail,
    subject: mail.subject,
    html: mail.html,
  });
}

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
  } else if (err === "mismatch") {
    registerAlert = "Les deux mots de passe ne correspondent pas.";
  } else if (err === "otp_send") {
    registerAlert =
      "Le code OTP n'a pas pu etre envoye par e-mail. Verifiez SMTP_HOST / SMTP_PORT / MAIL_FROM sur l'hebergeur, puis recommencez l'inscription.";
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

router.get("/register/verify-otp", async (req, res) => {
  if (await redirectIfAlreadyAuthenticated(req, res)) return;
  const signupId = typeof req.query.sid === "string" ? req.query.sid.trim() : "";
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!signupId) {
    return res.redirect(302, "/register?err=champs");
  }
  return res.render("register-verify-otp", {
    signupId,
    email,
    error: null,
    success: null,
  });
});

router.post("/register", registerOtpLimiter, async (req, res) => {
  const body = mergeFormBody(req);
  const firstName = String(body.firstName || "").trim();
  const lastName = String(body.lastName || "").trim();
  const emailNorm = String(body.email || "")
    .trim()
    .toLowerCase();
  const password = String(body.password || "");
  const passwordConfirm = String(body.passwordConfirm || "");
  if (!firstName || !lastName || !emailNorm || !password || !passwordConfirm) {
    return res.redirect(302, "/register?err=champs");
  }
  if (password !== passwordConfirm) {
    return res.redirect(302, "/register?err=mismatch");
  }
  if (password.length < 6) {
    return res.redirect(302, "/register?err=password");
  }

  if (!isSupabaseAuthConfigured()) {
    return res.redirect(302, "/register?err=config");
  }

  cleanupPendingStaffRegisterSignups();

  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: emailNorm, mode: "insensitive" } },
    select: { id: true },
  });
  if (existingUser) {
    return res.redirect(302, "/register?err=exist");
  }

  const targetOrg =
    (await prisma.organization.findFirst({ where: { isPlatform: true }, select: { id: true } })) ||
    (await prisma.organization.findFirst({ select: { id: true } }));
  if (!targetOrg) {
    return res.redirect(302, "/register?err=org");
  }

  const otp = generateOtpCode();
  const signupId = crypto.randomUUID();
  pendingStaffRegisterSignups.set(signupId, {
    payload: { firstName, lastName, email: emailNorm, password, organizationId: targetOrg.id },
    otpHash: hashRegisterOtp(emailNorm, otp),
    expiresAt: Date.now() + ADMIN_REGISTER_OTP_TTL_MS,
  });

  try {
    await sendStaffRegisterOtpEmail(emailNorm, firstName, otp);
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      // En local sans catch-all SMTP (Mailpit/MailHog), permettre de tester le flux complet.
      // Ne jamais activer en production : le code serait visible cote serveur.
      // eslint-disable-next-line no-console
      console.warn(
        `[register-otp] Echec envoi e-mail (${err?.message || err}). Mode dev : OTP pour ${emailNorm} = ${otp}`
      );
    } else {
      pendingStaffRegisterSignups.delete(signupId);
      return res.redirect(302, `/register?err=otp_send`);
    }
  }

  const q = new URLSearchParams({ sid: signupId, email: emailNorm });
  return res.redirect(302, `/register/verify-otp?${q.toString()}`);
});

router.post("/register/verify-otp", registerOtpLimiter, async (req, res) => {
  if (await redirectIfAlreadyAuthenticated(req, res)) return;
  cleanupPendingStaffRegisterSignups();
  const body = mergeFormBody(req);
  const signupId = String(body.signupId || "").trim();
  const otp = String(body.otp || "").trim();
  const pending = pendingStaffRegisterSignups.get(signupId);
  if (!pending) {
    return res.status(400).render("register-verify-otp", {
      signupId: "",
      email: "",
      error: "Session OTP expirée ou introuvable. Recommencez l'inscription.",
      success: null,
    });
  }
  if (!otp || hashRegisterOtp(pending.payload.email, otp) !== pending.otpHash) {
    return res.status(400).render("register-verify-otp", {
      signupId,
      email: pending.payload.email,
      error: "Code OTP invalide.",
      success: null,
    });
  }

  const { payload } = pending;
  const authUser = await ensureStaffSupabaseAuthUser(payload.email, payload.password);
  if (!authUser.ok) {
    if (String(authUser.error || "").includes("SUPABASE_SERVICE_ROLE_KEY")) {
      return res.redirect(302, "/register?err=config");
    }
    return res.status(400).render("register-verify-otp", {
      signupId,
      email: payload.email,
      error: `Creation du compte Auth impossible : ${authUser.error || "erreur inconnue"}`,
      success: null,
    });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          email: payload.email,
          passwordHash: null,
          authUid: authUser.authUid,
          firstName: payload.firstName,
          lastName: payload.lastName,
          role: Role.ADMIN,
          organizationId: payload.organizationId,
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
    return res.status(400).render("register-verify-otp", {
      signupId,
      email: payload.email,
      error: `Erreur inscription: ${error.message}`,
      success: null,
    });
  } finally {
    pendingStaffRegisterSignups.delete(signupId);
  }

  return res.redirect(302, "/register?ok=1");
});

async function renderStaffLoginPage(req, res, portalTarget, pageTitle, pageSubtitle) {
  if (await redirectIfAlreadyAuthenticated(req, res, portalTarget)) return;
  const err = typeof req.query.err === "string" ? req.query.err : "";
  return res.render("login", {
    loginAlert: loginAlertFromErr(err),
    pageTitle,
    pageSubtitle,
    loginAction: portalTarget === "superadmin" ? "/super-admin/login" : "/admin/login",
  });
}

async function handleStaffPortalLogin(req, res, portalTarget, errorBasePath) {
  const body = mergeFormBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const code = String(body.code || "");
  if (!email || (!password && !code)) {
    return res.redirect(302, `${errorBasePath}?err=champs`);
  }

  const result = await performUnifiedLogin(req, res, { email, password, code, targetPortal: portalTarget });
  if (!result.ok) {
    const reason = [
      "champs",
      "config",
      "provision",
      "code_court",
      "noprofile",
      "db",
      "forbidden_portal",
    ].includes(result.reason)
      ? result.reason
      : "auth";
    return res.redirect(302, `${errorBasePath}?err=${encodeURIComponent(reason)}`);
  }
  return res.redirect(302, result.redirect);
}

router.get("/login", (_req, res) => res.redirect(302, "/admin/login"));

router.get("/admin/login", async (req, res) => {
  return renderStaffLoginPage(
    req,
    res,
    "admin",
    "Connexion admin boutique",
    "Accès au portail boutique (produits, commandes, clients et statistiques)."
  );
});

router.post("/admin/login", loginLimiter, async (req, res) => {
  return handleStaffPortalLogin(req, res, "admin", "/admin/login");
});

router.get("/super-admin/login", async (req, res) => {
  return renderStaffLoginPage(
    req,
    res,
    "superadmin",
    "Connexion super admin",
    "Accès réservé à l'administration plateforme Clean Service."
  );
});

router.post("/super-admin/login", loginLimiter, async (req, res) => {
  return handleStaffPortalLogin(req, res, "superadmin", "/super-admin/login");
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
