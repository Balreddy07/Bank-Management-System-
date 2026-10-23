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
      const [rows] = await databasePool.execute(
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
      req.user = rows[0];
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