function createAuthMiddleware(databasePool) {
  async function requireAuth(req, res, next) {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({
        message: "Your session has expired. Sign in again.",
        code: "AUTH_REQUIRED",
      });
    }

    try {
      const isCustomer = req.session.userType === "CUSTOMER";
      const [rows] = isCustomer
        ? await databasePool.execute(
          `SELECT customer_id AS customerId, username
           FROM customer_users
           WHERE customer_id = ? AND is_active = 1`,
          [req.session.customerId]
        )
        : await databasePool.execute(
          `SELECT user_id AS userId, username, role
           FROM staff_users
           WHERE user_id = ? AND is_active = 1`,
          [userId]
        );
      if (!rows.length) {
        return req.session.destroy(() => res.status(401).json({
          message: "Your session has expired. Sign in again.",
          code: "AUTH_REQUIRED",
        }));
      }
      req.user = isCustomer
        ? { ...rows[0], userId: rows[0].customerId, role: "CUSTOMER" }
        : rows[0];
      return next();
    } catch (error) {
      console.error("Session user lookup failed:", error.code || "unknown error");
      return res.status(503).json({ message: "Authentication service is temporarily unavailable." });
    }
  }

  return { requireAuth };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "You do not have permission to perform this action." });
    }
    return next();
  };
}

module.exports = { createAuthMiddleware, requireRole };