const { prisma } = require("../db");
const { createSupabaseServiceClient } = require("../lib/supabase");

/** Filtre Prisma insensible à la casse (PostgreSQL). */
function emailMatchesInsensitive(emailLower) {
  return { equals: emailLower, mode: "insensitive" };
}

/**
 * Rattache la session Supabase à un membre d’équipe ou à un client portail (priorité équipe).
 * Met à jour authUid si l’utilisateur Auth correspond à l’e-mail métier sans lien encore.
 * Resynchronise authUid si l’e-mail correspond mais l’UUID Auth a changé (recréation côté Supabase).
 */
async function resolveAppIdentity(supabaseUser) {
  if (!supabaseUser?.id || !supabaseUser.email) return null;
  const email = String(supabaseUser.email).trim().toLowerCase();

  const staffByUid = await prisma.user.findFirst({
    where: { isActive: true, authUid: supabaseUser.id },
    include: { organization: true },
  });
  if (staffByUid) return { kind: "staff", user: staffByUid };

  const staffByEmail = await prisma.user.findFirst({
    where: { isActive: true, email: emailMatchesInsensitive(email), authUid: null },
    include: { organization: true },
  });
  if (staffByEmail) {
    await prisma.user.update({ where: { id: staffByEmail.id }, data: { authUid: supabaseUser.id } });
    return { kind: "staff", user: { ...staffByEmail, authUid: supabaseUser.id } };
  }

  const staffStaleAuth = await prisma.user.findFirst({
    where: { isActive: true, email: emailMatchesInsensitive(email), authUid: { not: null } },
    include: { organization: true },
  });
  if (staffStaleAuth && staffStaleAuth.authUid !== supabaseUser.id) {
    await prisma.user.update({
      where: { id: staffStaleAuth.id },
      data: { authUid: supabaseUser.id },
    });
    return { kind: "staff", user: { ...staffStaleAuth, authUid: supabaseUser.id } };
  }

  const custByUid = await prisma.customer.findFirst({
    where: { isActive: true, authUid: supabaseUser.id },
  });
  if (custByUid) return { kind: "portal", customer: custByUid };

  const custByEmail = await prisma.customer.findFirst({
    where: { isActive: true, email: emailMatchesInsensitive(email), authUid: null },
  });
  if (custByEmail) {
    await prisma.customer.update({ where: { id: custByEmail.id }, data: { authUid: supabaseUser.id } });
    return { kind: "portal", customer: { ...custByEmail, authUid: supabaseUser.id } };
  }

  const custStaleAuth = await prisma.customer.findFirst({
    where: { isActive: true, email: emailMatchesInsensitive(email), authUid: { not: null } },
  });
  if (custStaleAuth && custStaleAuth.authUid !== supabaseUser.id) {
    await prisma.customer.update({
      where: { id: custStaleAuth.id },
      data: { authUid: supabaseUser.id },
    });
    return { kind: "portal", customer: { ...custStaleAuth, authUid: supabaseUser.id } };
  }

  return null;
}

function isAlreadyRegisteredError(err) {
  const m = String(err?.message || err || "").toLowerCase();
  return m.includes("already") || m.includes("registered") || m.includes("exists");
}

function getAppBaseUrl() {
  return String(process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

async function findAuthUserByEmail(svc, emailNorm) {
  let page = 1;
  const perPage = 200;
  for (let i = 0; i < 10; i += 1) {
    const { data: pageData, error: listErr } = await svc.auth.admin.listUsers({ page, perPage });
    if (listErr) return null;
    const users = pageData?.users || [];
    const found = users.find((u) => String(u.email || "").toLowerCase() === emailNorm);
    if (found?.id) return found;
    if (!users.length || users.length < perPage) break;
    page += 1;
  }
  return null;
}

/**
 * Envoie l’e-mail d’invitation Supabase (lien pour définir le mot de passe).
 * Si l’utilisateur Auth existe déjà, renvoie son UUID sans renvoyer d’invitation.
 */
async function inviteStaffSupabaseUser(email, options = {}) {
  const svc = createSupabaseServiceClient();
  if (!svc) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY manquant." };

  const base = getAppBaseUrl();
  const path = options.redirectPath || "/login";
  const redirectTo = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const emailNorm = String(email).trim().toLowerCase();

  const { data, error } = await svc.auth.admin.inviteUserByEmail(emailNorm, { redirectTo });

  if (!error && data?.user?.id) {
    return { ok: true, authUid: data.user.id, sentInviteEmail: true, alreadyExisted: false };
  }

  if (error && isAlreadyRegisteredError(error)) {
    const found = await findAuthUserByEmail(svc, emailNorm);
    if (found?.id) {
      return { ok: true, authUid: found.id, sentInviteEmail: false, alreadyExisted: true };
    }
  }

  return { ok: false, error: error?.message || "Invitation Auth impossible." };
}

/**
 * Crée ou met à jour l’utilisateur Supabase Auth pour un client portail, puis renvoie l’UUID Auth.
 */
async function ensureCustomerSupabaseAuthUser(email, plainPassword) {
  const svc = createSupabaseServiceClient();
  if (!svc) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY manquant." };

  const { data: created, error: createErr } = await svc.auth.admin.createUser({
    email,
    password: plainPassword,
    email_confirm: true,
  });

  if (!createErr && created?.user?.id) {
    return { ok: true, authUid: created.user.id };
  }

  if (createErr && isAlreadyRegisteredError(createErr)) {
    let page = 1;
    const perPage = 200;
    for (let i = 0; i < 10; i += 1) {
      const { data: pageData, error: listErr } = await svc.auth.admin.listUsers({ page, perPage });
      if (listErr) return { ok: false, error: listErr.message };
      const users = pageData?.users || [];
      const found = users.find((u) => String(u.email || "").toLowerCase() === email);
      if (found?.id) {
        const { error: updErr } = await svc.auth.admin.updateUserById(found.id, { password: plainPassword });
        if (updErr) return { ok: false, error: updErr.message };
        return { ok: true, authUid: found.id };
      }
      if (!users.length || users.length < perPage) break;
      page += 1;
    }
    return { ok: false, error: "Compte Auth existant introuvable pour mise à jour." };
  }

  return { ok: false, error: createErr?.message || "Création Auth impossible." };
}

/**
 * Crée l’utilisateur Supabase pour un membre d’équipe (héritage mot de passe Prisma).
 */
async function ensureStaffSupabaseAuthUser(email, plainPassword) {
  return ensureCustomerSupabaseAuthUser(email, plainPassword);
}

module.exports = {
  resolveAppIdentity,
  ensureCustomerSupabaseAuthUser,
  ensureStaffSupabaseAuthUser,
  isAlreadyRegisteredError,
  inviteStaffSupabaseUser,
  getAppBaseUrl,
};
