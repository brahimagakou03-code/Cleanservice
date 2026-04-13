const { prisma } = require("../db");
const { createSupabaseServiceClient } = require("../lib/supabase");

/**
 * Rattache la session Supabase à un membre d’équipe ou à un client portail (priorité équipe).
 * Met à jour authUid si l’utilisateur Auth correspond à l’e-mail métier sans lien encore.
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
    where: { isActive: true, email, authUid: null },
    include: { organization: true },
  });
  if (staffByEmail) {
    await prisma.user.update({ where: { id: staffByEmail.id }, data: { authUid: supabaseUser.id } });
    return { kind: "staff", user: { ...staffByEmail, authUid: supabaseUser.id } };
  }

  const staffWrongLink = await prisma.user.findFirst({
    where: { isActive: true, email, authUid: { not: null } },
  });
  if (staffWrongLink && staffWrongLink.authUid !== supabaseUser.id) {
    return null;
  }

  const custByUid = await prisma.customer.findFirst({
    where: { isActive: true, authUid: supabaseUser.id },
  });
  if (custByUid) return { kind: "portal", customer: custByUid };

  const custByEmail = await prisma.customer.findFirst({
    where: { isActive: true, email, authUid: null },
  });
  if (custByEmail) {
    await prisma.customer.update({ where: { id: custByEmail.id }, data: { authUid: supabaseUser.id } });
    return { kind: "portal", customer: { ...custByEmail, authUid: supabaseUser.id } };
  }

  const custWrongLink = await prisma.customer.findFirst({
    where: { isActive: true, email, authUid: { not: null } },
  });
  if (custWrongLink && custWrongLink.authUid !== supabaseUser.id) {
    return null;
  }

  return null;
}

function isAlreadyRegisteredError(err) {
  const m = String(err?.message || err || "").toLowerCase();
  return m.includes("already") || m.includes("registered") || m.includes("exists");
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
};
