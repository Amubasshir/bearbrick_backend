const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const routes = require('./routes/api');
const dexRoutes = require('./routes/dex');
const adminRoutes = require('./routes/admin');
const dexProfileRoutes = require('./routes/dex-profile');
const dexFamiliesRoutes = require('./routes/dex-families');
const adminDashboardRoutes = require('./routes/admin-dashboard');
const sessionsRoutes = require('./routes/sessions');
const challengesRoutes = require('./routes/challenges');
const leaderboardsRoutes = require('./routes/leaderboards');
const rewardsRoutes = require('./routes/rewards');
const inboxRoutes = require('./routes/inbox');
const bountiesRoutes = require('./routes/bounties');
const uploadsRoutes = require('./routes/uploads');
const adminBountiesRoutes = require('./routes/admin-bounties');

const app = express();

app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://srv1333369.hstgr.cloud',
      'https://srv1333369.hstgr.cloud',
    ],
    credentials: true,
  }),
);
app.use(express.json());

// Swagger UI - load swagger file if it exists
try {
  const swaggerFile = require('./config/swagger-output.json');
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerFile));
} catch (error) {
  console.log(
    "Swagger file not found. Run 'npm run swagger-autogen' to generate it.",
  );
}

app.get("/", (req, res) => {
  res.json({
    message: "BE@RBRICK Crowd-Sourced Pricing Engine API",
    version: "1.0.0",
    status: "running",
    endpoints: {
      docs: "/api-docs",
      health: "/health",
      api: "/api",
    },
  });
});

app.use("/api", routes);
app.use("/api", dexRoutes);
app.use("/api", adminRoutes);
app.use("/api", dexProfileRoutes);
app.use("/api", dexFamiliesRoutes);
app.use("/api", adminDashboardRoutes);
app.use("/api", sessionsRoutes);
app.use("/api", challengesRoutes);
app.use("/api", leaderboardsRoutes);
app.use("/api", rewardsRoutes);
app.use("/api", inboxRoutes);
app.use("/api", bountiesRoutes);
app.use("/api", uploadsRoutes);
app.use("/api", adminBountiesRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = app;
