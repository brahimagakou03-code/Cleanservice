require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  console.log("Organizations:", orgs.length);
  for (const o of orgs) {
    const n = await prisma.product.count({ where: { organizationId: o.id } });
    const users = await prisma.user.findMany({
      where: { organizationId: o.id },
      select: { email: true, role: true },
    });
    const customers = await prisma.customer.count({ where: { organizationId: o.id } });
    console.log(
      "-",
      o.name,
      o.id,
      "products:",
      n,
      "users:",
      users.map((u) => `${u.email}(${u.role})`).join(", ") || "(none)",
      "customers:",
      customers
    );
  }
  await prisma.$disconnect();
})();
