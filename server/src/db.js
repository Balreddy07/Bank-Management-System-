
const mysql = require("mysql2/promise");
const { getDatabaseConfig } = require("./config");

const databaseConfig = getDatabaseConfig(process.env);

const pool = mysql.createPool({
  host: databaseConfig.host,
  port: databaseConfig.port,
  user: databaseConfig.user,
  password: databaseConfig.password,
  database: databaseConfig.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;
module.exports.databaseConfig = databaseConfig;
