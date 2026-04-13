const { prisma, requestContext } = require("../db");
const { createSupabaseRouteClient } = require("../utils/supabaseExpress");
const { resolveAppIdentity } = require("../utils/supabaseAuth");

async function requireClientPortalAuth(req, res, next) {
  try {
    const supabase = createSupabaseRouteClient(req, res);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      return res.redirect("/login?from=portal");
    }
    const identity = await resolveAppIdentity(data.user);
    if (!identity || identity.kind !== "portal") {
      if (identity?.kind === "staff") {
        return res.redirect("/dashboard");
      }
      return res.redirect("/login?from=portal");
    }
    const customer = await prisma.customer.findUnique({ where: { id: identity.customer.id } });
    if (!customer || !customer.isActive) {
      return res.redirect("/login?from=portal");
    }
    req.portalCustomer = customer;
    return requestContext.run(
      { organizationId: customer.organizationId, customerId: customer.id, role: "CUSTOMER" },
      () => next()
    );
  } catch (_) {
    return res.redirect("/login?from=portal");
  }
}

module.exports = { requireClientPortalAuth };
