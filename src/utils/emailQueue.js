const nodemailer = require("nodemailer");
const { prisma } = require("../db");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: Number(process.env.SMTP_PORT || 1025),
  secure: false,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
});

async function enqueueEmail({ organizationId, toEmail, subject, html }) {
  if (!toEmail) return;
  await prisma.emailQueue.create({
    data: { organizationId, toEmail, subject, html, status: "PENDING" },
  });
}

async function processEmailQueue(batchSize = 20) {
  const pending = await prisma.emailQueue.findMany({
    where: { status: "PENDING", attempts: { lt: 5 } },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });
  for (const item of pending) {
    try {
      await transporter.sendMail({
        from: process.env.MAIL_FROM || "noreply@clean-service.store",
        to: item.toEmail,
        subject: item.subject,
        html: item.html,
      });
      await prisma.emailQueue.update({
        where: { id: item.id },
        data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, error: null },
      });
    } catch (error) {
      await prisma.emailQueue.update({
        where: { id: item.id },
        data: { status: "PENDING", attempts: { increment: 1 }, error: String(error.message || error) },
      });
    }
  }
}

module.exports = { enqueueEmail, processEmailQueue };
