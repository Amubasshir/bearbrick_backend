/**
 * Shared test helpers for Dex Milestone 2 tests.
 */
const request = require("supertest");
const app = require("../../src/app");
const prisma = require("../../src/lib/prisma");

// Seeded constants
const BRICK_1 = "11111111-1111-4111-8111-111111111101"; // Series 1 Black, PUBLISHED
const BRICK_2 = "11111111-1111-4111-8111-111111111102"; // Series 2 Gold, PUBLISHED
const BRICK_3 = "11111111-1111-4111-8111-111111111103"; // Series 1 White, PUBLISHED

const SEEDED_EMAIL = "admin@example.com";
const SEEDED_PASSWORD = "password123";

// Admin secret — used for adminAuth in tests
const ADMIN_SECRET = "test-admin-secret";
process.env.ADMIN_SECRET = ADMIN_SECRET;

let _uidCounter = 0;

/**
 * Create a unique email for a fresh test user.
 */
function uniqueEmail() {
  return `testuser_${Date.now()}_${++_uidCounter}@dextest.invalid`;
}

/**
 * Sign up a fresh user and return { token, email, userId }.
 */
async function createFreshUser(suffix = "") {
  const email = uniqueEmail();
  const name = `Test User ${suffix || Date.now()}`;
  const res = await request(app)
    .post("/api/signup")
    .send({ name, email, password: "password123", email_verified: true });
  if (res.status !== 201) {
    throw new Error(`createFreshUser failed: ${JSON.stringify(res.body)}`);
  }
  const token = res.body.data?.token;
  const userId = res.body.data?.user?.id;
  return { token, email, userId, name };
}

/**
 * Create a fresh user, promote to is_admin=true, and return { token, email, userId }.
 * The signup-issued JWT stays valid because adminAuth re-reads isAdmin from the DB
 * per request. This is the standard admin-JWT (hasPermission-path) helper for the
 * Milestone 4 admin endpoints.
 */
async function createFreshAdmin(suffix = "") {
  const u = await createFreshUser(suffix);
  await prisma.$executeRawUnsafe(
    `UPDATE "User" SET is_admin = true WHERE id = $1`,
    BigInt(u.userId)
  );
  return u;
}

/**
 * Log in with existing credentials and return token.
 */
async function loginAs(email, password = "password123") {
  const res = await request(app).post("/api/login").send({ email, password });
  if (res.status !== 200) throw new Error(`loginAs(${email}) failed: ${res.status}`);
  return res.body.data.token;
}

/**
 * Perform the full Dex progression for a user on a brick (stages 0→3).
 * Returns the final BrickViewState.
 */
async function progressToStage3(token, brickId = BRICK_1, axis = "A", optionKey = "rarity") {
  const uid = `${Date.now()}-${Math.random()}`;

  // Stage 1: open
  await request(app)
    .post(`/api/dex/bricks/${brickId}/context/open`)
    .set("Authorization", `Bearer ${token}`);

  // Stage 1: progress (meets criteria)
  await request(app)
    .post(`/api/dex/bricks/${brickId}/context/progress`)
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", `progress-${uid}`)
    .send({ dwell_seconds: 15, scroll_pct: 85, interaction_seen: false });

  // Stage 2: vote
  await request(app)
    .post(`/api/dex/bricks/${brickId}/vote`)
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", `vote-${uid}`)
    .send({ vote_type: "FAIR" });

  // Stage 3: value driver
  const res = await request(app)
    .post(`/api/dex/bricks/${brickId}/value-driver`)
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", `vd-${uid}`)
    .send({ axis, option_key: optionKey });

  return res;
}

/**
 * Admin request helper — uses X-Admin-Secret header.
 */
function adminReq() {
  return {
    get: (path) =>
      request(app).get(path).set("X-Admin-Secret", ADMIN_SECRET),
    post: (path) =>
      request(app).post(path).set("X-Admin-Secret", ADMIN_SECRET),
    patch: (path) =>
      request(app).patch(path).set("X-Admin-Secret", ADMIN_SECRET),
    delete: (path) =>
      request(app).delete(path).set("X-Admin-Secret", ADMIN_SECRET),
  };
}

module.exports = {
  app,
  BRICK_1,
  BRICK_2,
  BRICK_3,
  SEEDED_EMAIL,
  SEEDED_PASSWORD,
  ADMIN_SECRET,
  uniqueEmail,
  createFreshUser,
  createFreshAdmin,
  loginAs,
  progressToStage3,
  adminReq,
};
