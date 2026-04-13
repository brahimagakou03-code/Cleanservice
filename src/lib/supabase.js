/**
 * Clients Supabase (API REST / Auth / Storage).
 * L’authentification navigateur repose sur Supabase Auth (@supabase/ssr + cookies) ;
 * Prisma lie User.authUid / Customer.authUid à auth.users.
 * Ne jamais exposer SUPABASE_SERVICE_ROLE_KEY au navigateur.
 */
const { createClient } = require("@supabase/supabase-js");

function getSupabaseUrl() {
  return process.env.SUPABASE_URL || "";
}

function getSupabaseAnonKey() {
  return process.env.SUPABASE_ANON_KEY || "";
}

function getSupabaseServiceRoleKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

/** Client lecture / usages côté serveur avec droits limités (RLS côté Supabase si activée). */
function createSupabaseAnonClient() {
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Admin API : contourne RLS — réservé au backend de confiance uniquement. */
function createSupabaseServiceClient() {
  const url = getSupabaseUrl();
  const key = getSupabaseServiceRoleKey();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = {
  createSupabaseAnonClient,
  createSupabaseServiceClient,
  getSupabaseUrl,
  getSupabaseAnonKey,
  getSupabaseServiceRoleKey,
};
