
const path = require("node:path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createApp } = require("./app");
const { getRuntimeConfig, loadEnvironmentFile, sanitizeConfigValue } = require("./config");

loadEnvironmentFile();

let runtimeConfig;
try {
  runtimeConfig = getRuntimeConfig(process.env);
} catch (error) {
  const message = sanitizeConfigValue(error.message || "Missing configuration.");
  console.error("Application startup failed.", message);
  process.exit(1);
}

const app = createApp({
  loginRateLimit: runtimeConfig.loginRateLimit,
  sessionSecret: runtimeConfig.sessionSecret,
  secureCookie: runtimeConfig.secureCookie,
  sameSite: runtimeConfig.sameSite,
  allowedOrigins: runtimeConfig.corsOrigins,
});

app.listen(runtimeConfig.port, () => {
  console.log(`Bank Management System API running on port ${runtimeConfig.port}`);
  console.log(
    `Login rate limit: ${runtimeConfig.loginRateLimit} attempts per 15 minutes`
  );
});
