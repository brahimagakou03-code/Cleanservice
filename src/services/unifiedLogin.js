const { prisma } = require("../db");
const { Role } = require("../utils/rbac");
const { comparePassword } = require("../utils/auth");
const { createSupabaseRouteClient } = require("../utils/supabaseExpress");
const {
  resolveAppIdentity,
  resolveAppAccessProfiles,
  ensureCustomerSupabaseAuthUser,
  ensureStaffSupabaseAuthUser,
} = require("../utils/supabaseAuth");

function codesMatch(input, stored) {
  const a = String(input || "")
    .trim()
    .toUpperCase();
  const b = String(stored || "")
    .trim()
    .toUpperCase();
  return a.length > 0 && a === b;
}

async function portalCredentialsValid(customer, password, code) {
  const pwd = String(password || "").trim();
  const codeOk = codesMatch(code, customer.code);
  if (customer.portalPasswordHash) {
    const pwdOk = pwd.length > 0 && (await comparePassword(pwd, customer.portalPasswordHash));
    return pwdOk || codeOk;
  }
  return codeOk;
}

function effectivePasswordForSupabase(password, code, customer) {
  const pwd = String(password || "").trim();
  const c = String(code || "").trim();
  if (pwd.length >= 6) return pwd;
  if (customer.portalPasswordHash && pwd.length > 0) return pwd;
  if (c.length >= 6) return c;
  if (c.length > 0) return `${c}_CsPortal1`;
  return "";
}

function isPrismaDbUnreachable(err) {
  const code = err?.code;
  const msg = String(err?.message || "");
  return code === "P1001" || msg.includes("Can't reach database server") || msg.includes("P1001");
}

async function syncCustomerAuthUidIfSupported(customerId, authUid) {
  try {
    await prisma.customer.update({ where: { id: customerId }, data: { authUid } });
  } catch (err) {
    const msg = String(err?.message || "");
    // Compatibilite DB: ne bloque pas le login si Customer.authUid n'existe pas encore.
    if (msg.includes("Customer.authUid") && msg.includes("does not exist")) return;
    throw err;
  }
}

/**
 * Connexion unique (Supabase Auth) : e-mail + mot de passe ; code client optionnel (héritage).
 * @returns {{ ok: true, redirect: string, trace?: object[] } | { ok: false, reason: string, message?: string, trace?: object[], stepFailed?: string }}
 */
function normalizeTargetPortal(targetPortal) {
  const p = String(targetPortal || "auto").trim().toLowerCase();
  if (p === "superadmin" || p === "admin" || p === "client") return p;
  return "auto";
}

function canAccessTargetPortal(access, targetPortal) {
  const staff = access?.staff || null;
  const customer = access?.customer || null;
  if (targetPortal === "auto") return Boolean(staff || customer);
  if (targetPortal === "client") return Boolean(customer);
  if (targetPortal === "admin") {
    // Portail admin boutique: reserve aux comptes staff d'une organisation non plateforme.
    return Boolean(staff && staff.organization?.isPlatform !== true);
  }
  if (targetPortal === "superadmin") {
    return Boolean(staff && staff.organization?.isPlatform === true && staff.role === Role.PLATFORM_ADMIN);
  }
  return false;
}

function redirectForTargetPortal(access, targetPortal) {
  if (targetPortal === "client") return "/portal";
  if (targetPortal === "superadmin") return "/dashboard/platform";
  if (targetPortal === "admin") return "/dashboard";
  if (access.staff) {
    if (access.staff.organization?.isPlatform === true && access.staff.role === Role.PLATFORM_ADMIN) {
      return "/dashboard/platform";
    }
    return "/dashboard";
  }
  return "/portal";
}

async function performUnifiedLogin(req, res, { email, password, code, targetPortal }) {
  const em = String(email || "").trim().toLowerCase();
  const pwd = String(password || "");
  const cod = String(code || "");
  const target = normalizeTargetPortal(targetPortal);

  if (!em || (!pwd && !cod)) {
    return {
      ok: false,
      reason: "champs",
      stepFailed: "validate_input",
      trace: [
        {
          step: "validate_input",
          status: "fail",
          detail: "E-mail absent ou mot de passe et code client tous vides.",
        },
      ],
    };
  }

  try {
    return await performUnifiedLoginInner(req, res, { email: em, password: pwd, code: cod, targetPortal: target });
  } catch (e) {
    if (isPrismaDbUnreachable(e)) {
      return {
        ok: false,
        reason: "db",
        message: e.message,
        stepFailed: "database",
        trace: [{ step: "database", status: "fail", detail: String(e.message || "").slice(0, 400) }],
      };
    }
    throw e;
  }
}

function tracePush(trace, step, status, detail = "") {
  trace.push({
    step,
    status,
    detail: String(detail || "").slice(0, 500),
  });
}

async function performUnifiedLoginInner(req, res, { email: em, password: pwd, code: cod, targetPortal }) {
  const trace = [];
  tracePush(trace, "start", "ok", `Portail demandé: ${targetPortal}, e-mail saisi (présent)`);

  let supabase;
  try {
    supabase = createSupabaseRouteClient(req, res);
    tracePush(trace, "supabase_client", "ok", "Client Supabase route (cookies) créé.");
  } catch (e) {
    tracePush(trace, "supabase_client", "fail", e.message);
    return { ok: false, reason: "config", message: e.message, trace, stepFailed: "supabase_client" };
  }

  const tryPassword = pwd || (cod.length >= 6 ? cod : "");
  let authUser = null;

  if (tryPassword) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: em,
      password: tryPassword,
    });
    if (!error && data?.user) {
      authUser = data.user;
      tracePush(trace, "supabase_signin_password", "ok", "Supabase Auth a accepté e-mail + mot de passe (ou code ≥6 car. utilisé comme mot de passe).");
    } else {
      tracePush(
        trace,
        "supabase_signin_password",
        "fail",
        error?.message || "Identifiants Supabase incorrects ou compte inexistant côté Auth.",
      );
    }
  } else {
    tracePush(
      trace,
      "supabase_signin_password",
      "skip",
      "Aucun mot de passe utilisable pour Auth (mot de passe vide et code client absent ou < 6 car.).",
    );
  }

  if (!authUser) {
    const localUser = await prisma.user.findFirst({
      where: { email: { equals: em, mode: "insensitive" } },
    });
    if (!localUser) {
      tracePush(trace, "staff_prisma_lookup", "info", "Aucun utilisateur interne (User) trouvé pour cet e-mail.");
    } else if (!localUser.passwordHash) {
      tracePush(trace, "staff_legacy_password", "skip", "Utilisateur interne trouvé mais sans passwordHash Prisma (connexion uniquement via Supabase).");
    } else if (!pwd) {
      tracePush(trace, "staff_legacy_password", "skip", "Mot de passe formulaire vide : impossible de vérifier le hash Prisma.");
    } else if (!(await comparePassword(pwd, localUser.passwordHash))) {
      tracePush(trace, "staff_legacy_password", "fail", "Mot de passe ne correspond pas au hash Prisma (héritage).");
    } else {
      tracePush(trace, "staff_legacy_password", "ok", "Mot de passe Prisma valide : provisionnement Auth Supabase…");
      const ensured = await ensureStaffSupabaseAuthUser(em, pwd);
      if (!ensured.ok) {
        tracePush(trace, "staff_supabase_provision", "fail", ensured.error || "Erreur ensureStaffSupabaseAuthUser.");
        return {
          ok: false,
          reason: "provision",
          message: ensured.error,
          trace,
          stepFailed: "staff_supabase_provision",
        };
      }
      tracePush(trace, "staff_supabase_provision", "ok", "Compte / lien Supabase staff prêt.");
      await prisma.user.update({ where: { id: localUser.id }, data: { authUid: ensured.authUid } });
      const { data, error } = await supabase.auth.signInWithPassword({ email: em, password: pwd });
      if (error || !data?.user) {
        tracePush(trace, "staff_signin_after_provision", "fail", error?.message || "Connexion refusée après provision.");
        return {
          ok: false,
          reason: "auth",
          message: error?.message || "Connexion refusée.",
          trace,
          stepFailed: "staff_signin_after_provision",
        };
      }
      authUser = data.user;
      tracePush(trace, "staff_signin_after_provision", "ok", "Session Supabase obtenue après héritage Prisma.");
    }
  }

  if (!authUser) {
    let hits = [];
    try {
      hits = await prisma.customer.findMany({
        where: { isActive: true, email: { equals: em, mode: "insensitive" } },
        take: 1,
      });
    } catch (err) {
      tracePush(trace, "customer_lookup", "fail", String(err?.message || err));
      return { ok: false, reason: "auth", trace, stepFailed: "customer_lookup" };
    }
    const hit = hits[0];
    if (!hit) {
      tracePush(trace, "customer_lookup", "info", "Aucun client actif (Customer) avec cet e-mail.");
    } else {
      tracePush(trace, "customer_lookup", "ok", `Client trouvé (id court: ${hit.id.slice(0, 8)}…).`);
      const customer = await prisma.customer.findUnique({ where: { id: hit.id } });
      if (!customer) {
        tracePush(trace, "customer_load", "fail", "Lecture Customer impossible.");
      } else if (!(await portalCredentialsValid(customer, pwd, cod))) {
        tracePush(
          trace,
          "customer_credentials",
          "fail",
          "Mot de passe portail et code client ne correspondent pas aux données enregistrées.",
        );
      } else {
        tracePush(trace, "customer_credentials", "ok", "Code client et/ou mot de passe portail acceptés.");
        const plain = effectivePasswordForSupabase(pwd, cod, customer);
        if (plain.length < 6) {
          tracePush(trace, "customer_password_policy", "fail", "Mot de passe dérivé pour Supabase < 6 caractères (exigence Supabase).");
          return {
            ok: false,
            reason: "code_court",
            message:
              "Mot de passe ou code trop court pour activer le compte (min. 6 caractères). Utilisez le mot de passe reçu par e-mail ou définissez-en un via votre fournisseur.",
            trace,
            stepFailed: "customer_password_policy",
          };
        }
        const ensured = await ensureCustomerSupabaseAuthUser(em, plain);
        if (!ensured.ok) {
          tracePush(trace, "customer_supabase_provision", "fail", ensured.error || "ensureCustomerSupabaseAuthUser");
          return {
            ok: false,
            reason: "provision",
            message: ensured.error,
            trace,
            stepFailed: "customer_supabase_provision",
          };
        }
        tracePush(trace, "customer_supabase_provision", "ok", "Utilisateur Auth client prêt / mis à jour.");
        await syncCustomerAuthUidIfSupported(customer.id, ensured.authUid);
        const { data, error } = await supabase.auth.signInWithPassword({ email: em, password: plain });
        if (error || !data?.user) {
          tracePush(trace, "customer_signin_after_provision", "fail", error?.message || "Connexion refusée.");
          return {
            ok: false,
            reason: "auth",
            message: error?.message || "Connexion refusée.",
            trace,
            stepFailed: "customer_signin_after_provision",
          };
        }
        authUser = data.user;
        tracePush(trace, "customer_signin_after_provision", "ok", "Session Supabase obtenue pour le portail client.");
      }
    }
  }

  if (!authUser) {
    tracePush(
      trace,
      "auth_user_resolution",
      "fail",
      "Impossible d'obtenir une session Supabase : combinaison e-mail / mot de passe / code non reconnue par aucune voie (Auth direct, staff Prisma, client).",
    );
    return { ok: false, reason: "auth", trace, stepFailed: "auth_user_resolution" };
  }

  const { data: verified } = await supabase.auth.getUser();
  const user = verified?.user || authUser;
  tracePush(trace, "session_get_user", "ok", "Jeton session relu via getUser().");

  const identity = await resolveAppIdentity(user);
  if (!identity) {
    await supabase.auth.signOut();
    tracePush(
      trace,
      "resolve_identity",
      "fail",
      "Supabase Auth OK mais aucune ligne User (staff) ni Customer (portail) active ne correspond à ce compte en base métier.",
    );
    return { ok: false, reason: "noprofile", trace, stepFailed: "resolve_identity" };
  }
  tracePush(
    trace,
    "resolve_identity",
    "ok",
    identity.kind === "staff"
      ? `Profil staff : rôle ${identity.user?.role || "?"}, org plateforme=${identity.user?.organization?.isPlatform === true}.`
      : "Profil portail client (Customer) résolu.",
  );

  const access = await resolveAppAccessProfiles(user);
  const staff = access.staff;
  const cust = access.customer;
  tracePush(
    trace,
    "access_profiles",
    "ok",
    `Staff=${Boolean(staff)} (boutique=${staff && staff.organization?.isPlatform !== true}), Client=${Boolean(cust)}.`,
  );

  if (!canAccessTargetPortal(access, targetPortal)) {
    await supabase.auth.signOut();
    tracePush(
      trace,
      "portal_eligibility",
      "fail",
      `Le portail « ${targetPortal} » refuse ce compte (droits ou type d organisation). Ex. admin boutique exige un User hors siège ; client exige un Customer.`,
    );
    return { ok: false, reason: "forbidden_portal", trace, stepFailed: "portal_eligibility" };
  }
  tracePush(trace, "portal_eligibility", "ok", `Accès autorisé pour le portail « ${targetPortal} ».`);

  if (identity.kind === "staff") {
    await prisma.user.update({ where: { id: identity.user.id }, data: { lastLoginAt: new Date() } });
    const redirect = redirectForTargetPortal(access, targetPortal);
    tracePush(trace, "redirect", "ok", `Redirection prévue : ${redirect}`);
    return { ok: true, redirect, trace, stepFailed: null };
  }

  const redirect = redirectForTargetPortal(access, targetPortal);
  tracePush(trace, "redirect", "ok", `Redirection prévue : ${redirect}`);
  return { ok: true, redirect, trace, stepFailed: null };
}

module.exports = { performUnifiedLogin, portalCredentialsValid, codesMatch };
