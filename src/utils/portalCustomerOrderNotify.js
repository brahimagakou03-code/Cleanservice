const { enqueueEmail } = require("./emailQueue");

/** Statuts alignés sur utils/orders (évite require circulaire avec routes/orders). */
const S = {
  DRAFT: "DRAFT",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  CONFIRMED: "CONFIRMED",
  IN_PREPARATION: "IN_PREPARATION",
  SHIPPED: "SHIPPED",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
};

/**
 * Alerte portail client + file d’e-mail (si adresse renseignée) pour les changements de statut clés.
 */
async function notifyCustomerOrderOutcome(prisma, { orderId, fromStatus, toStatus, cancelComment }) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true },
  });
  if (!order?.customer) return;

  const customer = order.customer;
  const baseUrl = process.env.APP_BASE_URL || "http://127.0.0.1:3000";

  const shouldNotifyConfirmed =
    toStatus === S.CONFIRMED && [S.DRAFT, S.PENDING_APPROVAL].includes(fromStatus);
  const shouldNotifyInPreparation =
    toStatus === S.IN_PREPARATION && fromStatus === S.CONFIRMED;
  const shouldNotifyShipped =
    toStatus === S.SHIPPED && fromStatus === S.IN_PREPARATION;
  const shouldNotifyDelivered =
    toStatus === S.DELIVERED && fromStatus === S.SHIPPED;
  const shouldNotifyCancelled = toStatus === S.CANCELLED && fromStatus !== S.CANCELLED;

  if (!shouldNotifyConfirmed && !shouldNotifyInPreparation && !shouldNotifyShipped && !shouldNotifyDelivered && !shouldNotifyCancelled) return;

  let title;
  let message;
  let type;

  if (shouldNotifyConfirmed) {
    type = "ORDER_CONFIRMED";
    title = "Commande validée";
    message = `Votre commande ${order.number} a été validée par votre fournisseur. Elle va être préparée puis expédiée selon les modalités convenues.`;
  } else if (shouldNotifyInPreparation) {
    type = "ORDER_IN_PREPARATION";
    title = "Commande en préparation";
    message = `Votre commande ${order.number} est en cours de préparation.`;
  } else if (shouldNotifyShipped) {
    type = "ORDER_SHIPPED";
    title = "Colis expédié";
    message = `Votre colis pour la commande ${order.number} a été expédié.`;
  } else if (shouldNotifyDelivered) {
    type = "ORDER_DELIVERED";
    title = "Commande livrée";
    message = `La commande ${order.number} est marquée comme livrée.`;
  } else {
    type = "ORDER_REFUSED";
    title = "Commande refusée ou annulée";
    const reason = cancelComment ? ` Motif communiqué : ${cancelComment}` : "";
    message = `Votre commande ${order.number} a été annulée par votre fournisseur.${reason}`;
  }

  await prisma.portalNotification.create({
    data: {
      organizationId: order.organizationId,
      customerId: customer.id,
      orderId: order.id,
      type,
      title,
      message,
    },
  });

  if (!customer.email) return;

  let subject;
  if (shouldNotifyConfirmed) subject = `Commande ${order.number} validée`;
  else if (shouldNotifyInPreparation) subject = `Commande ${order.number} en préparation`;
  else if (shouldNotifyShipped) subject = `Colis expédié - ${order.number}`;
  else if (shouldNotifyDelivered) subject = `Commande livrée - ${order.number}`;
  else subject = `Commande ${order.number} annulée`;
  const html = `
    <p>Bonjour ${escapeHtml(customer.companyName)},</p>
    <p>${escapeHtml(message)}</p>
    <p><a href="${baseUrl}/portal">Ouvrir mon espace client</a></p>
    <p style="color:#666;font-size:12px;">Message automatique — ne pas répondre directement à cet e-mail.</p>
  `;
  await enqueueEmail({ organizationId: order.organizationId, toEmail: customer.email, subject, html });
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { notifyCustomerOrderOutcome };
