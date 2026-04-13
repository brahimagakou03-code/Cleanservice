const { createServerClient } = require("@supabase/ssr");
const { useSecureCookies } = require("./cookieFlags");

function expressCookieOptionsFromSupabase(options) {
  if (!options || typeof options !== "object") return {};
  const out = {
    path: options.path || "/",
    httpOnly: options.httpOnly !== false,
    secure: Boolean(options.secure),
    sameSite: options.sameSite || "lax",
  };
  if (options.domain) out.domain = options.domain;
  if (options.maxAge != null) {
    const ma = Number(options.maxAge);
    if (ma === 0) out.maxAge = 0;
    else if (Number.isFinite(ma)) out.maxAge = ma * 1000;
  }
  return out;
}

/**
 * Client Supabase Auth par requête Express (cookies PKCE / session @supabase/ssr).
 * Appeler tôt dans le handler ; après `getUser()` / `signInWithPassword`, les Set-Cookie peuvent être posés.
 */
function createSupabaseRouteClient(req, res) {
  const url = process.env.SUPABASE_URL || "";
  const anon = process.env.SUPABASE_ANON_KEY || "";
  if (!url || !anon) {
    throw new Error("SUPABASE_URL et SUPABASE_ANON_KEY sont obligatoires pour l’authentification.");
  }
  const secure = useSecureCookies();
  return createServerClient(url, anon, {
    cookieOptions: {
      path: "/",
      sameSite: "lax",
      secure,
    },
    cookies: {
      getAll() {
        const jar = req.cookies || {};
        return Object.keys(jar).map((name) => ({ name, value: String(jar[name] ?? "") }));
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) {
          const o = expressCookieOptionsFromSupabase(options || {});
          o.secure = o.secure || secure;
          if (value) res.cookie(name, value, o);
          else res.clearCookie(name, { path: o.path || "/", sameSite: o.sameSite, secure: o.secure });
        }
        if (headers && typeof headers === "object") {
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        }
      },
    },
  });
}

function isSupabaseAuthConfigured() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const anon = String(process.env.SUPABASE_ANON_KEY || "").trim();
  return Boolean(url && anon);
}

module.exports = { createSupabaseRouteClient, isSupabaseAuthConfigured };
