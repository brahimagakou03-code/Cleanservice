const express = require("express");
const { prisma } = require("../db");
const { can, Role } = require("../utils/rbac");
const { enqueueEmail } = require("../utils/emailQueue");
const { teamInvitationTemplate } = require("../utils/emailTemplates");
const { createSupabaseServiceClient } = require("../lib/supabase");
const { inviteStaffSupabaseUser, getAppBaseUrl } = require("../utils/supabaseAuth");
const { orderStatusLabel } = require("../middleware/i18nFr");
const { canApprove, STATUS: ORDER_STATUS } = require("../utils/orders");

/** Lignes de commande exclues du volume TTC par catégorie (pas du « CA encaissé »). */
const EXCLUDE_ORDER_STATUS_FOR_CATEGORY_VOLUME = [ORDER_STATUS.DRAFT, ORDER_STATUS.CANCELLED];

const DASHBOARD_TODO_STATUSES = [
  ORDER_STATUS.PENDING_APPROVAL,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.IN_PREPARATION,
  ORDER_STATUS.SHIPPED,
];

const TODO_STATUS_RANK = {
  [ORDER_STATUS.PENDING_APPROVAL]: 0,
  [ORDER_STATUS.CONFIRMED]: 1,
  [ORDER_STATUS.IN_PREPARATION]: 2,
  [ORDER_STATUS.SHIPPED]: 3,
};

const TODO_NEXT_ACTION_FR = {
  [ORDER_STATUS.PENDING_APPROVAL]: "Approuver ou rejeter",
  [ORDER_STATUS.CONFIRMED]: "Mettre en préparation",
  [ORDER_STATUS.IN_PREPARATION]: "Marquer comme expédiée",
  [ORDER_STATUS.SHIPPED]: "Marquer comme livrée",
};

const router = express.Router();
const { withSkipTenant } = require("../db");
const {
  getAssignableTenantRoles,
  getAssignablePlatformRoles,
  canInviteTenantMembers,
  actorCanSetTenantRole,
} = require("../utils/teamRoles");

function requirePlatformAdmin(req, res, next) {
  if (!req.organization?.isPlatform) {
    return res.status(403).send("Accès réservé au siège Clean Service.");
  }
  if (!can(req.user.role, "platform:read")) {
    return res.status(403).send("Profil administrateur plateforme requis.");
  }
  next();
}

router.get("/platform", requirePlatformAdmin, (_req, res) => {
  res.redirect("/dashboard/platform/organizations");
});

router.get("/platform/organizations", requirePlatformAdmin, async (req, res, next) => {
  try {
    const organizations = await withSkipTenant(() =>
      prisma.organization.findMany({
        where: { isPlatform: false },
        orderBy: { name: "asc" },
        include: { _count: { select: { users: true, customers: true } } },
      }),
    );
    return res.render("platform-organizations", { organizations });
  } catch (e) {
    return next(e);
  }
});

router.get("/platform/users", requirePlatformAdmin, async (req, res) => {
  const members = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  return res.render("platform-team", {
    members,
    assignableRoles: getAssignablePlatformRoles(),
    isPlatformContext: true,
  });
});

router.post("/platform/users/invite", requirePlatformAdmin, async (req, res) => {
  const { email, firstName, lastName, role } = req.body;
  const allowed = getAssignablePlatformRoles();
  const safeRole = allowed.includes(role) ? role : allowed[0];
  const emailNorm = String(email || "").trim().toLowerCase();
  if (!emailNorm) {
    return res.status(400).send("E-mail obligatoire.");
  }
  if (!canInviteTenantMembers(req.user.role)) {
    return res.status(403).send("Droits insuffisants pour inviter.");
  }

  const svc = createSupabaseServiceClient();
  if (!svc) {
    return res.status(503).send("Supabase (SUPABASE_SERVICE_ROLE_KEY) non configure.");
  }

  const invite = await inviteStaffSupabaseUser(emailNorm, { redirectPath: "/login" });
  if (!invite.ok) {
    return res.status(400).send(`Compte Auth : ${invite.error}`);
  }

  try {
    await prisma.user.create({
      data: {
        email: emailNorm,
        firstName: firstName || "Invite",
        lastName: lastName || "User",
        role: safeRole,
        organizationId: req.user.organizationId,
        authUid: invite.authUid,
        passwordHash: null,
      },
    });
  } catch (error) {
    if (!invite.alreadyExisted) {
      try {
        await svc.auth.admin.deleteUser(invite.authUid);
      } catch (_) {
        /* ignore */
      }
    }
    return res.status(400).send(`Invitation impossible: ${error.message}`);
  }

  const base = getAppBaseUrl();
  const tpl = teamInvitationTemplate({
    firstName: firstName || "Utilisateur",
    inviteLink: `${base}/login`,
    supabaseInviteSent: invite.sentInviteEmail,
    existingSupabaseAccount: invite.alreadyExisted,
  });
  await enqueueEmail({
    organizationId: req.user.organizationId,
    toEmail: emailNorm,
    subject: tpl.subject,
    html: tpl.html,
  });
  return res.redirect("/dashboard/platform/users");
});

router.post("/platform/users/:id/role", requirePlatformAdmin, async (req, res) => {
  const { role } = req.body;
  const allowed = getAssignablePlatformRoles();
  if (!allowed.includes(role)) {
    return res.status(400).send("Rôle plateforme invalide.");
  }
  const target = await prisma.user.findFirst({ where: { id: req.params.id } });
  if (!target || target.organizationId !== req.user.organizationId) {
    return res.status(404).send("Membre introuvable.");
  }
  await prisma.user.update({ where: { id: target.id }, data: { role } });
  return res.redirect("/dashboard/platform/users");
});

router.post("/platform/users/:id/toggle-active", requirePlatformAdmin, async (req, res) => {
  const target = await prisma.user.findFirst({ where: { id: req.params.id } });
  if (!target || target.organizationId !== req.user.organizationId) {
    return res.status(404).send("Membre introuvable.");
  }
  if (target.id === req.user.sub) {
    return res.status(400).send("Vous ne pouvez pas désactiver votre propre compte depuis cette page.");
  }
  await prisma.user.update({ where: { id: target.id }, data: { isActive: !target.isActive } });
  return res.redirect("/dashboard/platform/users");
});

router.get("/", async (req, res) => {
  if (req.organization?.isPlatform) {
    return res.redirect("/dashboard/platform");
  }
  const orgId = req.user.organizationId;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const [
    customers,
    notificationsUnread,
    recentNotifications,
    paidThisMonth,
    paidPrevMonth,
    ordersThisMonth,
    ordersPrevMonth,
    overdueStats,
    monthlyRevenueRaw,
    topClientsRaw,
    orderStatusRaw,
    caByCategoryRaw,
    latestOrders,
    overdueInvoices,
    customerRetentionRaw,
    ordersTodoRaw,
    orderVolumeByCustomerRaw,
  ] = await Promise.all([
    prisma.customer.count({ where: { organizationId: orgId, isActive: true } }),
    prisma.notification.count({ where: { userId: req.user.sub, isRead: false } }),
    prisma.notification.findMany({ where: { userId: req.user.sub }, orderBy: { createdAt: "desc" }, take: 6 }),
    prisma.invoice.aggregate({
      where: { organizationId: orgId, status: "PAID", paidAt: { gte: monthStart }, type: "INVOICE" },
      _sum: { amountPaid: true },
    }),
    prisma.invoice.aggregate({
      where: { organizationId: orgId, status: "PAID", paidAt: { gte: prevMonthStart, lte: prevMonthEnd }, type: "INVOICE" },
      _sum: { amountPaid: true },
    }),
    prisma.order.count({ where: { organizationId: orgId, createdAt: { gte: monthStart } } }),
    prisma.order.count({ where: { organizationId: orgId, createdAt: { gte: prevMonthStart, lte: prevMonthEnd } } }),
    prisma.invoice.aggregate({
      where: { organizationId: orgId, status: "OVERDUE" },
      _sum: { amountDue: true },
      _count: { id: true },
    }),
    prisma.invoice.findMany({
      where: {
        organizationId: orgId,
        status: "PAID",
        type: "INVOICE",
        paidAt: { gte: new Date(now.getFullYear() - 1, now.getMonth(), 1) },
      },
      select: { paidAt: true, amountPaid: true },
    }),
    prisma.invoice.findMany({
      where: { organizationId: orgId, status: "PAID", type: "INVOICE" },
      include: { customer: true },
    }),
    prisma.order.groupBy({ by: ["status"], where: { organizationId: orgId }, _count: { status: true } }),
    prisma.orderLine.findMany({
      where: { organizationId: orgId },
      include: { product: { include: { category: true } }, order: true },
    }),
    prisma.order.findMany({
      where: { organizationId: orgId },
      include: { customer: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.invoice.findMany({
      where: { organizationId: orgId, status: "OVERDUE" },
      include: { customer: true },
      orderBy: { dueAt: "asc" },
      take: 10,
    }),
    prisma.customer.findMany({
      where: { organizationId: orgId },
      include: { orders: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
    prisma.order.findMany({
      where: { organizationId: orgId, status: { in: DASHBOARD_TODO_STATUSES } },
      include: { customer: true },
      orderBy: { createdAt: "asc" },
      take: 40,
    }),
    prisma.order.groupBy({
      by: ["customerId"],
      where: {
        organizationId: orgId,
        status: { notIn: EXCLUDE_ORDER_STATUS_FOR_CATEGORY_VOLUME },
      },
      _sum: { totalTtc: true },
    }),
  ]);

  const ordersTodo = [...ordersTodoRaw]
    .sort(
      (a, b) =>
        (TODO_STATUS_RANK[a.status] ?? 99) - (TODO_STATUS_RANK[b.status] ?? 99) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      totalTtc: o.totalTtc,
      createdAt: o.createdAt,
      customer: o.customer,
      nextActionLabel: TODO_NEXT_ACTION_FR[o.status] || "—",
    }));

  const paidMonth = Number(paidThisMonth._sum.amountPaid || 0);
  const paidPrev = Number(paidPrevMonth._sum.amountPaid || 0);
  const caEvolutionPct = paidPrev > 0 ? ((paidMonth - paidPrev) / paidPrev) * 100 : 100;
  const ordersEvolutionPct = ordersPrevMonth > 0 ? ((ordersThisMonth - ordersPrevMonth) / ordersPrevMonth) * 100 : 100;

  const monthlyMap = new Map();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyMap.set(k, 0);
  }
  monthlyRevenueRaw.forEach((r) => {
    if (!r.paidAt) return;
    const k = `${r.paidAt.getFullYear()}-${String(r.paidAt.getMonth() + 1).padStart(2, "0")}`;
    if (monthlyMap.has(k)) monthlyMap.set(k, monthlyMap.get(k) + Number(r.amountPaid || 0));
  });
  const monthlyRevenue = [...monthlyMap.entries()].map(([month, value]) => ({ month, value: Number(value.toFixed(2)) }));

  const topClientAgg = new Map();
  topClientsRaw.forEach((inv) => {
    const key = inv.customer.companyName;
    topClientAgg.set(key, (topClientAgg.get(key) || 0) + Number(inv.amountPaid || 0));
  });
  const topClients = [...topClientAgg.entries()]
    .map(([name, value]) => ({ name, value: Number(value.toFixed(2)) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const volCustomerIds = orderVolumeByCustomerRaw.map((r) => r.customerId).filter(Boolean);
  const volCustomers =
    volCustomerIds.length > 0
      ? await prisma.customer.findMany({
          where: { organizationId: orgId, id: { in: volCustomerIds } },
          select: { id: true, companyName: true },
        })
      : [];
  const volNameById = new Map(volCustomers.map((c) => [c.id, c.companyName || "Client"]));
  const topClientsByOrders = [...orderVolumeByCustomerRaw]
    .map((r) => ({
      name: volNameById.get(r.customerId) || "Client",
      value: Number(Number(r._sum.totalTtc || 0).toFixed(2)),
    }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const orderStatus = orderStatusRaw.map((s) => ({ status: orderStatusLabel(s.status), value: s._count.status }));

  const categoryAgg = new Map();
  caByCategoryRaw.forEach((l) => {
    const st = l.order?.status;
    if (!st || EXCLUDE_ORDER_STATUS_FOR_CATEGORY_VOLUME.includes(st)) return;
    const cat = l.product?.category?.name || "Sans catégorie";
    categoryAgg.set(cat, (categoryAgg.get(cat) || 0) + Number(l.lineTotalTtc || 0));
  });
  const caByCategory = [...categoryAgg.entries()].map(([name, value]) => ({ name, value: Number(value.toFixed(2)) }));

  const retentionAlerts = customerRetentionRaw
    .filter((c) => {
      const last = c.orders[0]?.createdAt;
      if (!last) return true;
      const diff = (now.getTime() - last.getTime()) / 86400000;
      return diff > 30;
    })
    .slice(0, 10);

  res.render("dashboard", {
    user: req.user,
    isPlatformOrg: req.organization?.isPlatform === true,
    canTeamManage: can(req.user.role, "team:manage"),
    canPlatform: can(req.user.role, "platform:read"),
    stats: {
      customers,
      kpi: {
        revenueMonth: paidMonth,
        revenueEvolutionPct: Number(caEvolutionPct.toFixed(1)),
        ordersMonth: ordersThisMonth,
        ordersEvolutionPct: Number(ordersEvolutionPct.toFixed(1)),
        overdueCount: overdueStats._count.id || 0,
        overdueAmount: Number(overdueStats._sum.amountDue || 0),
      },
    },
    charts: { monthlyRevenue, topClients, topClientsByOrders, orderStatus, caByCategory },
    lists: { latestOrders, overdueInvoices, retentionAlerts, ordersTodo },
    canApproveOrders: canApprove(req.user.role),
    notifications: { unread: notificationsUnread, recent: recentNotifications },
  });
});

router.get("/settings/team", async (req, res) => {
  if (req.organization?.isPlatform) {
    return res.redirect("/dashboard/platform/users");
  }
  if (!canInviteTenantMembers(req.user.role)) {
    return res.status(403).send("Accès refusé : droits « équipe » insuffisants.");
  }
  const members = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  return res.render("team-settings", {
    members,
    role: req.user.role,
    assignableRoles: getAssignableTenantRoles(req.user.role),
  });
});

router.post("/settings/team/invite", async (req, res) => {
  if (req.organization?.isPlatform) {
    return res.redirect("/dashboard/platform/users");
  }
  if (!canInviteTenantMembers(req.user.role)) {
    return res.status(403).send("Accès refusé : droits « équipe » insuffisants.");
  }

  const { email, firstName, lastName, role } = req.body;
  const allowed = getAssignableTenantRoles(req.user.role);
  const safeRole = allowed.includes(role) ? role : Role.MEMBER;
  const emailNorm = String(email || "").trim().toLowerCase();
  if (!emailNorm) {
    return res.status(400).send("E-mail obligatoire.");
  }

  const svc = createSupabaseServiceClient();
  if (!svc) {
    return res.status(503).send("Supabase (SUPABASE_SERVICE_ROLE_KEY) non configure : invitation impossible.");
  }

  const invite = await inviteStaffSupabaseUser(emailNorm, { redirectPath: "/login" });
  if (!invite.ok) {
    return res.status(400).send(`Compte Auth : ${invite.error}`);
  }

  try {
    await prisma.user.create({
      data: {
        email: emailNorm,
        firstName: firstName || "Invite",
        lastName: lastName || "User",
        role: safeRole,
        organizationId: req.user.organizationId,
        authUid: invite.authUid,
        passwordHash: null,
      },
    });
  } catch (error) {
    if (!invite.alreadyExisted) {
      try {
        await svc.auth.admin.deleteUser(invite.authUid);
      } catch (_) {
        /* ignore */
      }
    }
    return res.status(400).send(`Invitation impossible: ${error.message}`);
  }

  const base = getAppBaseUrl();
  const tpl = teamInvitationTemplate({
    firstName: firstName || "Utilisateur",
    inviteLink: `${base}/login`,
    supabaseInviteSent: invite.sentInviteEmail,
    existingSupabaseAccount: invite.alreadyExisted,
  });
  await enqueueEmail({
    organizationId: req.user.organizationId,
    toEmail: emailNorm,
    subject: tpl.subject,
    html: tpl.html,
  });
  return res.redirect("/dashboard/settings/team");
});

router.post("/settings/team/:id/role", async (req, res) => {
  if (req.organization?.isPlatform) {
    return res.redirect("/dashboard/platform/users");
  }
  if (!canInviteTenantMembers(req.user.role)) {
    return res.status(403).send("Accès refusé : droits « équipe » insuffisants.");
  }

  const { role } = req.body;
  const target = await prisma.user.findFirst({ where: { id: req.params.id } });
  if (!target || target.organizationId !== req.user.organizationId) {
    return res.status(404).send("Membre introuvable.");
  }
  const allowedRoles = getAssignableTenantRoles(req.user.role);
  if (!allowedRoles.includes(role)) {
    return res.status(400).send("Rôle invalide.");
  }
  if (!actorCanSetTenantRole(req.user.role, role)) {
    return res.status(400).send("Vous ne pouvez pas attribuer ce rôle.");
  }

  await prisma.user.update({ where: { id: target.id }, data: { role } });
  return res.redirect("/dashboard/settings/team");
});

router.post("/settings/team/:id/toggle-active", async (req, res) => {
  if (req.organization?.isPlatform) {
    return res.redirect("/dashboard/platform/users");
  }
  if (!canInviteTenantMembers(req.user.role)) {
    return res.status(403).send("Accès refusé : droits « équipe » insuffisants.");
  }

  const target = await prisma.user.findFirst({ where: { id: req.params.id } });
  if (!target || target.organizationId !== req.user.organizationId) {
    return res.status(404).send("Membre introuvable");
  }
  if (target.id === req.user.sub) {
    return res.status(400).send("Vous ne pouvez pas désactiver votre propre compte depuis cette page.");
  }
  await prisma.user.update({ where: { id: target.id }, data: { isActive: !target.isActive } });
  return res.redirect("/dashboard/settings/team");
});

const BRANDING_SITE_ID = "site";

function canManageBranding(role) {
  return role === Role.OWNER || role === Role.ADMIN;
}

function assertLogoMime(mimetype) {
  if (!/^image\/(png|jpeg|pjpeg|webp|gif|svg\+xml)$/i.test(String(mimetype || ""))) {
    throw new Error("Logo : utilisez PNG, JPEG, WebP, GIF ou SVG.");
  }
}

function assertFaviconMime(mimetype, originalname) {
  const m = String(mimetype || "").toLowerCase();
  const name = String(originalname || "").toLowerCase();
  if (/^image\/(png|jpeg|pjpeg|webp|gif|svg\+xml|vnd\.microsoft\.icon|x-icon)$/.test(m)) return;
  if (m === "application/octet-stream" && name.endsWith(".ico")) return;
  throw new Error("Favicon : ICO, PNG ou JPEG recommandés (fichier .ico ou image carrée 32×32).");
}

function toDataUrl(buffer, mimetype) {
  const mt = String(mimetype || "application/octet-stream").split(";")[0].trim();
  return `data:${mt};base64,${buffer.toString("base64")}`;
}

router.get("/branding", async (req, res) => {
  if (!canManageBranding(req.user.role)) {
    return res.status(403).send("Accès réservé aux propriétaires et administrateurs.");
  }
  let row = null;
  try {
    row = await prisma.platformBranding.findUnique({ where: { id: BRANDING_SITE_ID } });
  } catch {
    row = null;
  }
  return res.render("branding-settings", {
    hasCustomLogo: Boolean(row?.logoDataUrl),
    hasCustomFavicon: Boolean(row?.faviconDataUrl),
  });
});

router.post("/branding/logo", async (req, res) => {
  if (!canManageBranding(req.user.role)) {
    return res.status(403).send("Accès réservé aux propriétaires et administrateurs.");
  }
  const f = req.file;
  if (!f || !f.buffer) return res.status(400).send("Aucun fichier reçu. Glissez-déposez ou choisissez un fichier.");
  try {
    assertLogoMime(f.mimetype);
  } catch (e) {
    return res.status(400).send(e.message);
  }
  const dataUrl = toDataUrl(f.buffer, f.mimetype);
  await prisma.platformBranding.upsert({
    where: { id: BRANDING_SITE_ID },
    create: { id: BRANDING_SITE_ID, logoDataUrl: dataUrl },
    update: { logoDataUrl: dataUrl },
  });
  return res.redirect("/dashboard/branding");
});

router.post("/branding/favicon", async (req, res) => {
  if (!canManageBranding(req.user.role)) {
    return res.status(403).send("Accès réservé aux propriétaires et administrateurs.");
  }
  const f = req.file;
  if (!f || !f.buffer) return res.status(400).send("Aucun fichier reçu.");
  try {
    assertFaviconMime(f.mimetype, f.originalname);
  } catch (e) {
    return res.status(400).send(e.message);
  }
  const dataUrl = toDataUrl(f.buffer, f.mimetype);
  await prisma.platformBranding.upsert({
    where: { id: BRANDING_SITE_ID },
    create: { id: BRANDING_SITE_ID, faviconDataUrl: dataUrl },
    update: { faviconDataUrl: dataUrl },
  });
  return res.redirect("/dashboard/branding");
});

router.post("/branding/reset", async (req, res) => {
  if (!canManageBranding(req.user.role)) {
    return res.status(403).send("Accès réservé aux propriétaires et administrateurs.");
  }
  const target = String(req.body.target || "all");
  const data = {};
  if (target === "logo") data.logoDataUrl = null;
  else if (target === "favicon") data.faviconDataUrl = null;
  else if (target === "all") {
    data.logoDataUrl = null;
    data.faviconDataUrl = null;
  } else {
    return res.status(400).send("Cible de réinitialisation invalide.");
  }
  await prisma.platformBranding.upsert({
    where: { id: BRANDING_SITE_ID },
    create: { id: BRANDING_SITE_ID, ...data },
    update: data,
  });
  return res.redirect("/dashboard/branding");
});

module.exports = router;
