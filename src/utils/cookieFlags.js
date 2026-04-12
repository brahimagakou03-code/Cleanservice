/**
 * Cookies « Secure » uniquement en HTTPS réel, pour que CSRF + JWT fonctionnent sur Netlify.
 * Définir APP_BASE_URL=https://… sur l’hébergeur, ou COOKIE_SECURE=true / false explicitement.
 */
function useSecureCookies() {
  if (process.env.COOKIE_SECURE === "false" || process.env.CSRF_COOKIE_SECURE === "false") return false;
  if (process.env.COOKIE_SECURE === "true" || process.env.CSRF_COOKIE_SECURE === "true") return true;
  const base = String(process.env.APP_BASE_URL || "").trim().toLowerCase();
  if (base.startsWith("https:")) return true;
  if (base.startsWith("http:")) return false;
  return (
    process.env.NETLIFY === "true" ||
    process.env.CONTEXT === "production" ||
    process.env.NODE_ENV === "production"
  );
}

module.exports = { useSecureCookies };
