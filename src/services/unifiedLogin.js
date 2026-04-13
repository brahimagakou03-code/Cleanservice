const { prisma } = require("../db");
const { Role } = require("../utils/rbac");
const { comparePassword } = require("../utils/auth");
const { createSupabaseRouteClient } = require("../utils/supabaseExpress");
const {
  resolveAppIdentity,
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

/**
 * Connexion unique (Supabase Auth) : e-mail + mot de passe ; code client optionnel (héritage).
 * @returns {{ ok: true, redirect: string } | { ok: false, reason: string }}
 */
async function performUnifiedLogin(req, res, { email, password, code }) {
  const em = String(email || "").trim().toLowerCase();
  const pwd = String(password || "");
  const cod = String(code || "");

  if (!em || (!pwd && !cod)) {
    return { ok: false, reason: "champs" };
  }

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
    const localUser = await prisma.user.findUnique({ where: { email: em } });
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
        await prisma.customer.update({ where: { id: customer.id }, data: { authUid: ensured.authUid } });
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

  if (identity.kind === "staff") {
    await prisma.user.update({ where: { id: identity.user.id }, data: { lastLoginAt: new Date() } });
    const u = await prisma.user.findUnique({
      where: { id: identity.user.id },
      include: { organization: true },
    });
    let redirect = "/dashboard";
    if (u?.organization?.isPlatform === true && u.role === Role.PLATFORM_ADMIN) {
      redirect = "/dashboard/platform";
    }
    return { ok: true, redirect };
  }

  return { ok: true, redirect: "/portal" };
}

module.exports = { performUnifiedLogin, portalCredentialsValid, codesMatch };
