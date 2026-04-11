const { prisma, requestContext } = require("../db");
const { CLIENT_PORTAL_COOKIE, verifyClientPortalToken } = require("../utils/auth");

async function requireClientPortalAuth(req, res, next) {
  const token = req.cookies[CLIENT_PORTAL_COOKIE];
  if (!token) return res.redirect("/portal/login");
  try {
    const payload = verifyClientPortalToken(token);
    const customer = await prisma.customer.findUnique({ where: { id: payload.sub } });
    if (!customer || !customer.isActive) return res.redirect("/portal/login");
    req.portalCustomer = customer;
    return requestContext.run(
      { organizationId: customer.organizationId, customerId: customer.id, role: "CUSTOMER" },
      () => next()
    );
  } catch (_) {
    return res.redirect("/portal/login");
  }
}

module.exports = { requireClientPortalAuth };
