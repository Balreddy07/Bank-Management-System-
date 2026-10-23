const session = require("express-session");

class MySQLSessionStore extends session.Store {
  constructor(databasePool, { cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.databasePool = databasePool;
    this.cleanupTimer = setInterval(() => {
      this.databasePool.execute("DELETE FROM user_sessions WHERE expires <= UNIX_TIMESTAMP()")
        .catch((error) => console.error("Expired session cleanup failed:", error.code || "unknown error"));
    }, cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  get(sessionId, callback) {
    this.databasePool.execute(
      "SELECT data FROM user_sessions WHERE session_id = ? AND expires > UNIX_TIMESTAMP()",
      [sessionId]
    ).then(([rows]) => {
      if (rows.length) return JSON.parse(rows[0].data);
      return this.databasePool.execute(
        "DELETE FROM user_sessions WHERE session_id = ? AND expires <= UNIX_TIMESTAMP()",
        [sessionId]
      ).then(() => null);
    }).then((sessionData) => {
      callback(null, sessionData);
    }).catch((error) => callback(error));
  }

  set(sessionId, sessionData, callback = () => {}) {
    const expiration = sessionExpirySeconds(sessionData);
    this.databasePool.execute(
      `INSERT INTO user_sessions (session_id, expires, data)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
      [sessionId, expiration, JSON.stringify(sessionData)]
    ).then(() => callback(null)).catch((error) => callback(error));
  }

  touch(sessionId, sessionData, callback = () => {}) {
    const expiration = sessionExpirySeconds(sessionData);
    this.databasePool.execute(
      "UPDATE user_sessions SET expires = ?, data = ? WHERE session_id = ?",
      [expiration, JSON.stringify(sessionData), sessionId]
    ).then(() => callback(null)).catch((error) => callback(error));
  }

  destroy(sessionId, callback = () => {}) {
    this.databasePool.execute("DELETE FROM user_sessions WHERE session_id = ?", [sessionId])
      .then(() => callback(null)).catch((error) => callback(error));
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

function sessionExpirySeconds(sessionData) {
  const expirationMilliseconds = sessionData.cookie?.expires
    ? new Date(sessionData.cookie.expires).getTime()
    : Date.now() + Number(sessionData.cookie?.maxAge ?? 30 * 60 * 1000);
  return Math.floor(expirationMilliseconds / 1000);
}

module.exports = MySQLSessionStore;