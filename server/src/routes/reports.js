const express = require("express");
const pool = require("../db");

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function createReportRouter(databasePool = pool) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
      return res.status(400).json({ message: "Provide a valid start and end date, with startDate no later than endDate." });
    }

    const rangeStart = new Date(`${startDate}T00:00:00.000Z`);
    const rangeEnd = new Date(`${endDate}T00:00:00.000Z`);
    if ((rangeEnd - rangeStart) / 86400000 > 366) {
      return res.status(400).json({ message: "Report date range cannot exceed 367 days." });
    }

    try {
      const [[summaryRows], [accountRows]] = await Promise.all([
        databasePool.execute(
          `SELECT COUNT(*) AS transactionCount,
                  COALESCE(SUM(CASE WHEN transaction_type = 'DEPOSIT' THEN amount ELSE 0 END), 0) AS totalDeposits,
                  COALESCE(SUM(CASE WHEN transaction_type = 'WITHDRAWAL' THEN amount ELSE 0 END), 0) AS totalWithdrawals
           FROM transactions
           WHERE created_at >= ?
             AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
          [startDate, endDate]
        ),
        databasePool.execute(
          `SELECT COUNT(*) AS activeAccountCount,
                  COALESCE(SUM(balance), 0) AS totalBalance
           FROM accounts
           WHERE status = 'ACTIVE'`
        ),
      ]);

      return res.status(200).json({
        startDate,
        endDate,
        ...summaryRows[0],
        ...accountRows[0],
      });
    } catch (error) {
      console.error("Report generation failed:", error.code || "unknown error");
      return res.status(500).json({ message: "Unable to generate the report." });
    }
  });

  return router;
}

module.exports = createReportRouter();
module.exports.createReportRouter = createReportRouter;