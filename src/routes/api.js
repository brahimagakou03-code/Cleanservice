const express = require("express");
const { prisma } = require("../db");
const { can } = require("../utils/rbac");

const router = express.Router();

router.use((req, res, next) => {
  if (!req.user?.organizationId) return res.status(401).json({ error: "Non authentifie" });
  return next();
});

router.get("/clients", async (req, res) => {
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*") || can(req.user.role, "read:all"))) {
    return res.status(403).json({ error: "Interdit" });
  }
  const data = await prisma.client.findMany();
  return res.json(data);
});

router.post("/clients", async (req, res) => {
  if (!(can(req.user.role, "clients:manage") || can(req.user.role, "*"))) {
    return res.status(403).json({ error: "Interdit" });
  }
  const created = await prisma.client.create({ data: { name: req.body.name, email: req.body.email || null } });
  return res.status(201).json(created);
});

router.get("/products", async (req, res) => {
  if (!(can(req.user.role, "products:manage") || can(req.user.role, "*") || can(req.user.role, "read:all"))) {
    return res.status(403).json({ error: "Interdit" });
  }
  const data = await prisma.product.findMany();
  return res.json(data);
});

router.post("/products", async (req, res) => {
  if (!(can(req.user.role, "products:manage") || can(req.user.role, "*"))) {
    return res.status(403).json({ error: "Interdit" });
  }
  const created = await prisma.product.create({
    data: {
      name: req.body.name,
      sku: req.body.sku,
      basePriceHt: Number(req.body.basePriceHt || 0),
      vatRate: String(req.body.vatRate || "20"),
      unit: String(req.body.unit || "piece"),
    },
  });
  return res.status(201).json(created);
});

router.get("/orders", async (req, res) => {
  if (can(req.user.role, "orders:view:own")) {
    const data = await prisma.order.findMany({ where: { createdById: req.user.sub } });
    return res.json(data);
  }
  if (!(can(req.user.role, "orders:view") || can(req.user.role, "orders:manage") || can(req.user.role, "*") || can(req.user.role, "read:all"))) {
    return res.status(403).json({ error: "Interdit" });
  }
  const data = await prisma.order.findMany();
  return res.json(data);
});

router.post("/orders", async (req, res) => {
  if (!(can(req.user.role, "orders:create") || can(req.user.role, "orders:manage") || can(req.user.role, "*"))) {
    return res.status(403).json({ error: "Interdit" });
  }
  const created = await prisma.order.create({
    data: {
      number: req.body.number || `TMP-${Date.now()}`,
      customerId: req.body.customerId,
      status: "DRAFT",
      totalHt: Number(req.body.totalHt || 0),
      totalTva: Number(req.body.totalTva || 0),
      totalTtc: Number(req.body.totalTtc || 0),
      createdById: req.user.sub,
    },
  });
  return res.status(201).json(created);
});

module.exports = router;
