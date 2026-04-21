const express = require("express");

const router = express.Router();

/** Réviser cette date lors des mises à jour majeures du guide (captures / parcours). */
const GUIDE_REVISION = "2026-04-21k";

router.get("/", (_req, res) => {
  return res.render("admin-guide", { guideRevision: GUIDE_REVISION });
});

module.exports = router;
