
require("dotenv").config();

const { createApp } = require("./app");
const app = createApp();

const PORT = Number(process.env.PORT || 5000);

app.listen(PORT, () => {
  console.log(`Bank Management System API running on port ${PORT}`);
});
