const { prisma } = require("../db");

function isAuthLoginAttemptTableMissing(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");
  if (code === "P2021") return true;
  if (msg.includes("AuthLoginAttempt") && (msg.includes("does not exist") || msg.includes("Unknown model"))) return true;
  return false;
}

function clientIpFromReq(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const nfIp = String(req.headers["x-nf-client-connection-ip"] || "").trim();
  const socketIp = String(req.socket?.remoteAddress || "").trim();
  return forwarded || nfIp || req.ip || socketIp || "";
}

/**
 * Enregistre une tentative de connexion (admin boutique, client, super admin).
 * Ignore silencieusement si la table n'existe pas encore (migration non appliquée).
 */
async function recordAuthLoginAttempt(payload) {
  const {
    portal,
    email,
    success,
    outcome,
    stepFailed,
    trace,
    detailMessage,
    ip,
    userAgent,
  } = payload;
  let traceJson = null;
  try {
    traceJson = trace ? JSON.stringify(trace) : null;
  } catch {
    traceJson = null;
  }
  try {
    await prisma.authLoginAttempt.create({
      data: {
        portal: String(portal || "unknown").slice(0, 32),
        email: email ? String(email).trim().toLowerCase().slice(0, 320) : null,
        success: Boolean(success),
        outcome: String(outcome || (success ? "success" : "unknown")).slice(0, 64),
        stepFailed: stepFailed ? String(stepFailed).slice(0, 128) : null,
        trace: traceJson,
        detailMessage: detailMessage ? String(detailMessage).slice(0, 2000) : null,
        ip: ip ? String(ip).slice(0, 128) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
      },
    });
  } catch (err) {
    if (isAuthLoginAttemptTableMissing(err)) return;
    console.warn("[authLoginAudit] enregistrement impossible:", err?.message || err);
  }
}

module.exports = {
  recordAuthLoginAttempt,
  isAuthLoginAttemptTableMissing,
  clientIpFromReq,
};
