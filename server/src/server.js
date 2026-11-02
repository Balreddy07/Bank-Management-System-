
require("dotenv").config();

const { createApp } = require("./app");

const isProduction = process.env.NODE_ENV === "production";
const configuredLoginRateLimit = process.env.LOGIN_RATE_LIMIT;

let loginRateLimit = 20;

if (!isProduction && configuredLoginRateLimit !== undefined) {
  const parsedLimit = Number(configuredLoginRateLimit);

  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
    throw new Error("LOGIN_RATE_LIMIT must be a positive safe integer.");
  }

  loginRateLimit = parsedLimit;
}

const app = createApp({ loginRateLimit });

const PORT = Number(process.env.PORT || 5000);

app.listen(PORT, () => {
  console.log(`Bank Management System API running on port ${PORT}`);
  console.log(
    `Login rate limit: ${isProduction ? 20 : loginRateLimit} attempts per 15 minutes`
  );
});
