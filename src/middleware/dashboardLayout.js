const { prisma } = require("../db");
const { formatEuroHtDisplay, formatEuroHtInput, formatEuroTtcDisplay } = require("../utils/money");

function normalizeRequestPath(req) {
  let p = req.originalUrl.split("?")[0];
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p || "/";
}

async function loadDashboardLayout(req, res, next) {
  try {
    const [unread, recent] = await Promise.all([
      prisma.notification.count({ where: { userId: req.user.sub, isRead: false } }),
      prisma.notification.findMany({
        where: { userId: req.user.sub },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);
    res.locals.layout = {
      currentPath: normalizeRequestPath(req),
      user: req.user,
      notifications: { unread, recent },
      brandLogoUrl: "/branding/logo.png",
    };
    res.locals.formatEuroHtDisplay = formatEuroHtDisplay;
    res.locals.formatEuroHtInput = formatEuroHtInput;
    res.locals.formatEuroTtcDisplay = formatEuroTtcDisplay;
  } catch (_) {
    res.locals.layout = {
      currentPath: normalizeRequestPath(req),
      user: req.user,
      notifications: { unread: 0, recent: [] },
      brandLogoUrl: "/branding/logo.png",
    };
    res.locals.formatEuroHtDisplay = formatEuroHtDisplay;
    res.locals.formatEuroHtInput = formatEuroHtInput;
    res.locals.formatEuroTtcDisplay = formatEuroTtcDisplay;
  }
  return next();
}

module.exports = { loadDashboardLayout };
