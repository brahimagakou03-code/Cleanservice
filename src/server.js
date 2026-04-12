require("dotenv").config();
const { app } = require("./app");
const { prisma } = require("./db");
const { startInvoiceJobs } = require("./jobs/invoiceJobs");
const { startEmailQueueJob } = require("./jobs/emailQueueJob");

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  await prisma.$connect();
  startInvoiceJobs();
  startEmailQueueJob();
  console.log(`Serveur demarre sur http://localhost:${port}`);
});
