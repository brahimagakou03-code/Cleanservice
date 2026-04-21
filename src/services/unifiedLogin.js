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
 * @returns {{ ok: true, redirect: string } | { ok: false, reason: string }}
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
  if (targetPortal === "admin") return Boolean(staff);
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
    return { ok: false, reason: "champs" };
  }

  try {
    return await performUnifiedLoginInner(req, res, { email: em, password: pwd, code: cod, targetPortal: target });
  } catch (e) {
    if (isPrismaDbUnreachable(e)) {
      return { ok: false, reason: "db", message: e.message };
    }
    throw e;
  }
}

async function performUnifiedLoginInner(req, res, { email: em, password: pwd, code: cod, targetPortal }) {
  let supabase;
  try {
    supabase = createSupabaseRouteClient(req, res);
  } catch (e) {
    return { ok: false, reason: "config", message: e.message };
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
    }
  }

  if (!authUser) {
    const localUser = await prisma.user.findFirst({
      where: { email: { equals: em, mode: "insensitive" } },
    });
    if (localUser?.passwordHash && pwd && (await comparePassword(pwd, localUser.passwordHash))) {
      const ensured = await ensureStaffSupabaseAuthUser(em, pwd);
      if (!ensured.ok) {
        return { ok: false, reason: "provision", message: ensured.error };
      }
      await prisma.user.update({ where: { id: localUser.id }, data: { authUid: ensured.authUid } });
      const { data, error } = await supabase.auth.signInWithPassword({ email: em, password: pwd });
      if (error || !data?.user) {
        return { ok: false, reason: "auth", message: error?.message || "Connexion refusée." };
      }
      authUser = data.user;
    }
  }

  if (!authUser) {
    const hits = await prisma.customer.findMany({
      where: { isActive: true, email: { equals: em, mode: "insensitive" } },
      take: 1,
    });
    const hit = hits[0];
    if (hit) {
      const customer = await prisma.customer.findUnique({ where: { id: hit.id } });
      if (customer && (await portalCredentialsValid(customer, pwd, cod))) {
        const plain = effectivePasswordForSupabase(pwd, cod, customer);
        if (plain.length < 6) {
          return {
            ok: false,
            reason: "code_court",
            message:
              "Mot de passe ou code trop court pour activer le compte (min. 6 caractères). Utilisez le mot de passe reçu par e-mail ou définissez-en un via votre fournisseur.",
          };
        }
        const ensured = await ensureCustomerSupabaseAuthUser(em, plain);
        if (!ensured.ok) {
          return { ok: false, reason: "provision", message: ensured.error };
        }
        await syncCustomerAuthUidIfSupported(customer.id, ensured.authUid);
        const { data, error } = await supabase.auth.signInWithPassword({ email: em, password: plain });
        if (error || !data?.user) {
          return { ok: false, reason: "auth", message: error?.message || "Connexion refusée." };
        }
        authUser = data.user;
      }
    }
  }

  if (!authUser) {
    return { ok: false, reason: "auth" };
  }

  const { data: verified } = await supabase.auth.getUser();
  const user = verified?.user || authUser;
  const identity = await resolveAppIdentity(user);
  if (!identity) {
    await supabase.auth.signOut();
    return { ok: false, reason: "noprofile" };
  }

  const access = await resolveAppAccessProfiles(user);
  if (!canAccessTargetPortal(access, targetPortal)) {
    await supabase.auth.signOut();
    return { ok: false, reason: "forbidden_portal" };
  }

  if (identity.kind === "staff") {
    await prisma.user.update({ where: { id: identity.user.id }, data: { lastLoginAt: new Date() } });
    const redirect = redirectForTargetPortal(access, targetPortal);
    return { ok: true, redirect };
  }

  return { ok: true, redirect: redirectForTargetPortal(access, targetPortal) };
}

module.exports = { performUnifiedLogin, portalCredentialsValid, codesMatch };
