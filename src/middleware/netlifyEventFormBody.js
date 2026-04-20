/**
 * Sur Netlify, le corps peut être présent dans l'event Lambda alors que le
 * message HTTP synthétisé a un Content-Length erroné (0) : express.urlencoded
 * ne remplit pas req.body. On réinjecte les champs pour les POST d'auth.
 */
function netlifyEventFormBodyMerge(req, _res, next) {
  try {
    if (req.method !== "POST") return next();

    const pathname = String(req.path || "").replace(/\/+$/, "") || "/";
    const allowed = new Set(["/login", "/admin/login", "/super-admin/login", "/register", "/portal/login"]);
    if (!allowed.has(pathname)) return next();

    const event = req.apiGateway?.event;
    if (!event) return next();

    let raw = event.body;
    if (raw == null) return next();

    if (Buffer.isBuffer(raw)) {
      raw = raw.toString("utf8");
    } else if (typeof raw === "string") {
      if (event.isBase64Encoded) {
        raw = Buffer.from(raw, "base64").toString("utf8");
      }
    } else {
      return next();
    }

    if (!raw.includes("=")) return next();

    const fromEvent = Object.fromEntries(new URLSearchParams(raw));
    if (!Object.keys(fromEvent).length) return next();

    const existing =
      req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    req.body = { ...fromEvent, ...existing };
  } catch {
    /* ignore */
  }
  next();
}

module.exports = { netlifyEventFormBodyMerge };
