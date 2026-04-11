const { prisma } = require("../db");

const TYPE = {
  ORDER_RECEIVED: "ORDER_RECEIVED",
  ORDER_APPROVED: "ORDER_APPROVED",
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
  INVOICE_OVERDUE: "INVOICE_OVERDUE",
  LOW_STOCK: "LOW_STOCK",
  APPROVAL_NEEDED: "APPROVAL_NEEDED",
};

async function notifyUsersByRoles({ organizationId, roles, type, title, message, link }) {
  const users = await prisma.user.findMany({
    where: { organizationId, role: { in: roles }, isActive: true },
    select: { id: true },
  });
  if (!users.length) return;
  await prisma.notification.createMany({
    data: users.map((u) => ({ userId: u.id, organizationId, type, title, message, link: link || null })),
  });
}

async function notifyUser({ userId, organizationId, type, title, message, link }) {
  await prisma.notification.create({
    data: { userId, organizationId, type, title, message, link: link || null },
  });
}

module.exports = { TYPE, notifyUsersByRoles, notifyUser };
