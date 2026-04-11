const cron = require("node-cron");
const { prisma } = require("../db");
const { TYPE, notifyUsersByRoles } = require("../utils/notifications");
const { enqueueEmail } = require("../utils/emailQueue");
const { invoiceReminderTemplate } = require("../utils/emailTemplates");

function startInvoiceJobs() {
  cron.schedule("0 3 * * *", async () => {
    const now = new Date();
    const overdueBefore = await prisma.invoice.findMany({
      where: {
        dueAt: { lt: now },
        status: { in: ["SENT", "PARTIALLY_PAID"] },
        amountDue: { gt: 0 },
      },
      include: { customer: true },
    });
    await prisma.invoice.updateMany({
      where: {
        dueAt: { lt: now },
        status: { in: ["SENT", "PARTIALLY_PAID"] },
        amountDue: { gt: 0 },
      },
      data: { status: "OVERDUE" },
    });
    for (const inv of overdueBefore) {
      await notifyUsersByRoles({
        organizationId: inv.organizationId,
        roles: ["ADMIN", "OWNER"],
        type: TYPE.INVOICE_OVERDUE,
        title: "Facture en retard",
        message: `La facture ${inv.number || "(brouillon)"} est en retard.`,
        link: `/dashboard/invoices/${inv.id}`,
      });
    }
  });

  cron.schedule("30 3 * * *", async () => {
    const orgs = await prisma.organization.findMany();
    const now = new Date();
    for (const org of orgs) {
      const target = new Date(now);
      target.setDate(target.getDate() - Number(org.reminderDelayDays || 7));
      const overdue = await prisma.invoice.findMany({
        where: {
          organizationId: org.id,
          status: "OVERDUE",
          dueAt: { lte: target },
          amountDue: { gt: 0 },
        },
        include: { customer: true },
      });
      overdue.forEach((i) => {
        console.log(`[RELANCE AUTO] ${i.number} -> ${i.customer.email || "sans email"} | reste: ${i.amountDue}`);
      });
      for (const i of overdue) {
        if (!i.customer.email) continue;
        const tpl = invoiceReminderTemplate({
          invoiceNumber: i.number || "N/A",
          amountDue: i.amountDue,
          dueDate: i.dueAt ? i.dueAt.toISOString().slice(0, 10) : "-",
          paymentLink: `${process.env.APP_BASE_URL || "http://localhost:3000"}/dashboard/invoices/${i.id}`,
        });
        await enqueueEmail({ organizationId: i.organizationId, toEmail: i.customer.email, subject: tpl.subject, html: tpl.html });
      }
    }
  });

  cron.schedule("0 4 * * *", async () => {
    const lowStockProducts = await prisma.product.findMany({
      where: { stockQty: { not: null, lte: 5 } },
    });
    for (const p of lowStockProducts) {
      await notifyUsersByRoles({
        organizationId: p.organizationId,
        roles: ["ADMIN", "OWNER"],
        type: TYPE.LOW_STOCK,
        title: "Stock bas",
        message: `Le produit ${p.sku} - ${p.name} est en stock bas (${p.stockQty}).`,
        link: "/dashboard/catalog",
      });
    }
  });
}

module.exports = { startInvoiceJobs };
