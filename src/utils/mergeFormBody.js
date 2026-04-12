/**
 * Fusionne req.body (Express) et le fallback rempli depuis le buffer urlencoded
 * (contournement Netlify / serverless où req.body peut rester vide).
 */
function mergeFormBody(req) {
  const primary =
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const fb =
    req._formBodyFallback && typeof req._formBodyFallback === "object"
      ? req._formBodyFallback
      : {};
  return { ...fb, ...primary };
}

module.exports = { mergeFormBody };
