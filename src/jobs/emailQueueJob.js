const cron = require("node-cron");
const { processEmailQueue } = require("../utils/emailQueue");

function startEmailQueueJob() {
  cron.schedule("*/2 * * * *", async () => {
    await processEmailQueue(20);
  });
}

module.exports = { startEmailQueueJob };
