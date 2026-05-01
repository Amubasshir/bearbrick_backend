/**
 * Dex Profile Tests — Phase 2
 *
 * Covers:
 *   GET /api/dex/me           — full profile
 *   GET /api/dex/me/xp        — XP + level + history
 *   GET /api/dex/me/stats     — completion stats
 *   GET /api/dex/me/progress  — paginated brick list with stage
 *   GET /api/dex/leaderboard/xp
 *   GET /api/dex/leaderboard/completion
 */
const request = require("supertest");
const { app, BRICK_1, BRICK_2, createFreshUser, progressToStage3 } = require("../helpers/dex");

describe("Dex Profile — Auth required", () => {
  it("GET /dex/me returns 401 without token", async () => {
    const res = await request(app).get("/api/dex/me");
    expect(res.status).toBe(401);
  });

  it("GET /dex/me/xp returns 401 without token", async () => {
    const res = await request(app).get("/api/dex/me/xp");
    expect(res.status).toBe(401);
  });

  it("GET /dex/me/stats returns 401 without token", async () => {
    const res = await request(app).get("/api/dex/me/stats");
    expect(res.status).toBe(401);
  });

  it("GET /dex/me/progress returns 401 without token", async () => {
    const res = await request(app).get("/api/dex/me/progress");
    expect(res.status).toBe(401);
  });
});

describe("Dex Profile — Fresh user (stage 0)", () => {
  let token;

  beforeAll(async () => {
    ({ token } = await createFreshUser("profile-fresh"));
  });

  it("GET /dex/me returns profile with zero XP and correct shape", async () => {
    const res = await request(app)
      .get("/api/dex/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.user).toHaveProperty("id");
    expect(d.user).toHaveProperty("name");
    expect(d.user).toHaveProperty("email");
    expect(d.xp).toHaveProperty("totalXp");
    expect(d.xp.totalXp).toBe(0);
    expect(d.xp.level).toBe(1);
    expect(d.stats).toHaveProperty("total_bricks");
    expect(d.stats.bricks_by_stage).toBeDefined();
    expect(Array.isArray(d.recently_completed)).toBe(true);
  });

  it("GET /dex/me/xp returns level 1 with empty history", async () => {
    const res = await request(app)
      .get("/api/dex/me/xp")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalXp).toBe(0);
    expect(res.body.data.level).toBe(1);
    expect(Array.isArray(res.body.data.history)).toBe(true);
    expect(res.body.data.pagination).toBeDefined();
  });

  it("GET /dex/me/stats returns zero completion", async () => {
    const res = await request(app)
      .get("/api/dex/me/stats")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.bricks_by_stage[3]).toBe(0);
    expect(d.completion_pct).toBe(0);
    expect(d.total_xp).toBe(0);
    expect(d.level).toBe(1);
    expect(d.streak_days).toBeGreaterThanOrEqual(0);
  });

  it("GET /dex/me/progress returns empty list for fresh user", async () => {
    const res = await request(app)
      .get("/api/dex/me/progress")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });
});

describe("Dex Profile — User after stage 3 completion", () => {
  let token;

  beforeAll(async () => {
    ({ token } = await createFreshUser("profile-stage3"));
    // Complete full progression on BRICK_1
    await progressToStage3(token, BRICK_1);
  });

  it("GET /dex/me shows recently completed brick", async () => {
    const res = await request(app)
      .get("/api/dex/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const completed = res.body.data.recently_completed;
    expect(completed.some((r) => r.brick_id === BRICK_1)).toBe(true);
  });

  it("GET /dex/me/xp shows XP >= 30 (5+10+15)", async () => {
    const res = await request(app)
      .get("/api/dex/me/xp")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalXp).toBeGreaterThanOrEqual(30);
    expect(res.body.data.level).toBeGreaterThanOrEqual(1);
    expect(res.body.data.history.length).toBeGreaterThanOrEqual(3);
  });

  it("GET /dex/me/stats shows 1 brick at stage 3", async () => {
    const res = await request(app)
      .get("/api/dex/me/stats")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.bricks_by_stage[3]).toBeGreaterThanOrEqual(1);
    expect(d.total_xp).toBeGreaterThanOrEqual(30);
    expect(d.completion_pct).toBeGreaterThan(0);
  });

  it("GET /dex/me/progress shows brick at stage 3 with BrickViewState", async () => {
    const res = await request(app)
      .get("/api/dex/me/progress?stage=3")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const brick = res.body.data[0];
    expect(brick.user_stage).toBe(3);
    expect(brick).toHaveProperty("brick_id");
    expect(brick.price_visible).toBe(true);
  });

  it("GET /dex/me/progress with ?stage=1,2 shows no stage-3 bricks", async () => {
    const res = await request(app)
      .get("/api/dex/me/progress?stage=1,2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const b of res.body.data) {
      expect([1, 2]).toContain(b.user_stage);
    }
  });

  it("GET /dex/me/progress pagination works", async () => {
    // Complete BRICK_2 as well for pagination test
    await progressToStage3(token, BRICK_2);
    const res = await request(app)
      .get("/api/dex/me/progress?limit=1&page=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination.pages).toBeGreaterThanOrEqual(2);
  });
});

describe("Dex Leaderboards", () => {
  it("GET /dex/leaderboard/xp returns ranked list with level", async () => {
    const res = await request(app).get("/api/dex/leaderboard/xp");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const top = res.body.data[0];
      expect(top).toHaveProperty("rank");
      expect(top).toHaveProperty("user_id");
      expect(top).toHaveProperty("name");
      expect(top).toHaveProperty("total_xp");
      expect(top).toHaveProperty("level");
      expect(top.rank).toBe(1);
      // Ranks are sorted descending by XP
      if (res.body.data.length > 1) {
        expect(res.body.data[0].total_xp).toBeGreaterThanOrEqual(res.body.data[1].total_xp);
      }
    }
  });

  it("GET /dex/leaderboard/completion returns ranked list with completion %", async () => {
    const res = await request(app).get("/api/dex/leaderboard/completion");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length > 0) {
      const top = res.body.data[0];
      expect(top).toHaveProperty("rank");
      expect(top).toHaveProperty("user_id");
      expect(top).toHaveProperty("completed_bricks");
      expect(top).toHaveProperty("total_bricks");
      expect(top).toHaveProperty("completion_pct");
      expect(top.completion_pct).toBeGreaterThan(0);
    }
  });

  it("leaderboards do not expose passwords or sensitive fields", async () => {
    const res = await request(app).get("/api/dex/leaderboard/xp");
    for (const entry of res.body.data) {
      expect(entry).not.toHaveProperty("password");
      expect(entry).not.toHaveProperty("email");
    }
  });
});
