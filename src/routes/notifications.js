const express = require("express");
const { prisma } = require("../db");

const router = express.Router();

router.get("/", async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user.sub },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return res.render("notifications", { notifications });
});

router.post("/:id/read", async (req, res) => {
  await prisma.notification.update({
    where: { id: req.params.id },
    data: { isRead: true },
  });
  return res.redirect(req.get("referer") || "/dashboard/notifications");
});

router.post("/read-all", async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user.sub, isRead: false },
    data: { isRead: true },
  });
  return res.redirect(req.get("referer") || "/dashboard/notifications");
});

module.exports = router;
