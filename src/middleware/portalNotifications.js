const { prisma } = require("../db");

/**
 * Charge les alertes portail pour le header et la page d’accueil (jusqu’à 20 + compteur non lues).
 * À utiliser après requireClientPortalAuth.
 */
async function attachPortalNotifications(req, res, next) {
  if (!req.portalCustomer) return next();
  try {
    const customerId = req.portalCustomer.id;
    const [portalAlerts, portalUnreadCount] = await Promise.all([
      prisma.portalNotification.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.portalNotification.count({
        where: { customerId, isRead: false },
      }),
    ]);
    res.locals.portalAlerts = portalAlerts;
    res.locals.portalUnreadCount = portalUnreadCount;
  } catch (err) {
    console.error("attachPortalNotifications", err.message);
    res.locals.portalAlerts = [];
    res.locals.portalUnreadCount = 0;
  }
  next();
}

module.exports = { attachPortalNotifications };
