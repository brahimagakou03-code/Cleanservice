const { prisma, requestContext } = require("../db");
const { createSupabaseRouteClient } = require("../utils/supabaseExpress");
const { resolveAppAccessProfiles } = require("../utils/supabaseAuth");

async function requireClientPortalAuth(req, res, next) {
  try {
    const supabase = createSupabaseRouteClient(req, res);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      return res.redirect("/portal/login");
    }
    const access = await resolveAppAccessProfiles(data.user);
    if (!access.customer) {
      if (access.staff) return res.redirect("/dashboard");
      return res.redirect("/portal/login");
    }
    const customer = await prisma.customer.findUnique({ where: { id: access.customer.id } });
    if (!customer || !customer.isActive) {
      return res.redirect("/portal/login");
    }
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
