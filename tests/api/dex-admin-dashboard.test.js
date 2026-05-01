/**
 * Admin Dashboard Tests — Phase 2
 *
 * Covers:
 *   GET   /api/admin/bricks              — paginated brick list with stats
 *   GET   /api/admin/users               — paginated user list with XP + completion
 *   POST  /api/admin/bricks/bulk-status  — bulk status update
 *   PATCH /api/admin/bricks/:id/feature  — toggle featured flag
 *   GET   /api/admin/bricks/:id/event-log — audit trail
 */
const request = require("supertest");
const { app, BRICK_1, BRICK_2, adminReq, createFreshUser, ADMIN_SECRET } = require("../helpers/dex");

describe("Admin Dashboard — Auth enforcement", () => {
  it("GET /admin/bricks returns 401 without auth", async () => {
    const res = await request(app).get("/api/admin/bricks");
    expect(res.status).toBe(401);
  });

  it("GET /admin/users returns 401 without auth", async () => {
    const res = await request(app).get("/api/admin/users");
    expect(res.status).toBe(401);
  });

  it("GET /admin/bricks returns 403 with plain JWT", async () => {
    const { token } = await createFreshUser("dash-nonadmin");
    const res = await request(app)
      .get("/api/admin/bricks")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("Admin Dashboard — GET /api/admin/bricks", () => {
  it("returns 200 with paginated brick list", async () => {
    const res = await adminReq().get("/api/admin/bricks");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(5);
  });

  it("each brick includes stats object with users_by_stage", async () => {
    const res = await adminReq().get("/api/admin/bricks?limit=3");
    expect(res.status).toBe(200);
    for (const brick of res.body.data) {
      expect(brick).toHaveProperty("stats");
      expect(brick.stats).toHaveProperty("users_by_stage");
      expect(brick.stats).toHaveProperty("total_completions");
      expect(brick.stats).toHaveProperty("value_driver_breakdown");
    }
  });

  it("supports pagination", async () => {
    const page1 = await adminReq().get("/api/admin/bricks?page=1&limit=3");
    const page2 = await adminReq().get("/api/admin/bricks?page=2&limit=3");
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    const ids1 = page1.body.data.map((b) => b.id);
    const ids2 = page2.body.data.map((b) => b.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });
});

describe("Admin Dashboard — GET /api/admin/users", () => {
  it("returns 200 with paginated user list", async () => {
    const res = await adminReq().get("/api/admin/users");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
  });

  it("each user has XP, level, completion stats", async () => {
    const res = await adminReq().get("/api/admin/users?limit=5");
    expect(res.status).toBe(200);
    for (const u of res.body.data) {
      expect(u).toHaveProperty("id");
      expect(u).toHaveProperty("name");
      expect(u).toHaveProperty("email");
      expect(u).toHaveProperty("total_xp");
      expect(u).toHaveProperty("level");
      expect(u).toHaveProperty("completed_bricks");
      expect(u).toHaveProperty("completion_pct");
      // Does not expose password
      expect(u).not.toHaveProperty("password");
    }
  });
});

describe("Admin Dashboard — POST /api/admin/bricks/bulk-status", () => {
  let testBrickIds;

  beforeAll(async () => {
    // Create 2 bricks to bulk-update
    const r1 = await adminReq().post("/api/admin/bricks")
      .send({ name: "Bulk Target A", description_short: "Bulk test", status: "UNRELEASED" });
    const r2 = await adminReq().post("/api/admin/bricks")
      .send({ name: "Bulk Target B", description_short: "Bulk test", status: "UNRELEASED" });
    testBrickIds = [r1.body.data.id, r2.body.data.id];
  });

  it("returns 422 for empty ids array", async () => {
    const res = await adminReq().post("/api/admin/bricks/bulk-status")
      .send({ ids: [], status: "PUBLISHED" });
    expect(res.status).toBe(422);
  });

  it("returns 422 for invalid status", async () => {
    const res = await adminReq().post("/api/admin/bricks/bulk-status")
      .send({ ids: testBrickIds, status: "DELETED" });
    expect(res.status).toBe(422);
  });

  it("updates multiple bricks to PUBLISHED", async () => {
    const res = await adminReq().post("/api/admin/bricks/bulk-status")
      .send({ ids: testBrickIds, status: "PUBLISHED" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.updated).toBe(2);

    // Verify via GET
    for (const id of testBrickIds) {
      const check = await request(app).get(`/api/dex/bricks/${id}`);
      expect(check.body.data.status).toBe("PUBLISHED");
    }
  });

  it("bulk-status returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/admin/bricks/bulk-status")
      .send({ ids: testBrickIds, status: "PROTOTYPE" });
    expect(res.status).toBe(401);
  });
});

describe("Admin Dashboard — PATCH /api/admin/bricks/:id/feature", () => {
  let brickId;

  beforeAll(async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({ name: "Feature Toggle Brick", description_short: "Will be toggled", status: "PUBLISHED" });
    brickId = res.body.data.id;
  });

  it("returns 422 when featured is not a boolean", async () => {
    const res = await adminReq().patch(`/api/admin/bricks/${brickId}/feature`)
      .send({ featured: "yes" });
    expect(res.status).toBe(422);
  });

  it("returns 404 for unknown brick", async () => {
    const res = await adminReq().patch("/api/admin/bricks/00000000-0000-0000-0000-000000000000/feature")
      .send({ featured: true });
    expect(res.status).toBe(404);
  });

  it("sets featured=true", async () => {
    const res = await adminReq().patch(`/api/admin/bricks/${brickId}/feature`)
      .send({ featured: true });
    expect(res.status).toBe(200);
    expect(res.body.data.featured).toBe(true);
  });

  it("sets featured=false", async () => {
    const res = await adminReq().patch(`/api/admin/bricks/${brickId}/feature`)
      .send({ featured: false });
    expect(res.status).toBe(200);
    expect(res.body.data.featured).toBe(false);
  });

  it("featured brick appears in /dex/bricks/featured after toggle", async () => {
    await adminReq().patch(`/api/admin/bricks/${brickId}/feature`).send({ featured: true });
    const res = await request(app).get("/api/dex/bricks/featured");
    expect(res.status).toBe(200);
    expect(res.body.data.some((b) => b.brick_id === brickId)).toBe(true);
  });
});

describe("Admin Dashboard — Value Driver Options admin endpoints", () => {
  let optionId;

  it("POST /admin/value-driver-options returns 422 for invalid axis", async () => {
    const res = await adminReq().post("/api/admin/value-driver-options")
      .send({ axis: "Z", option_key: "test", label: "Test" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/axis/i);
  });

  it("POST /admin/value-driver-options creates a new option", async () => {
    const optKey = `test_opt_${Date.now()}`;
    const res = await adminReq().post("/api/admin/value-driver-options")
      .send({ axis: "A", option_key: optKey, label: "Test Label", display_order: 99 });
    expect(res.status).toBe(201);
    expect(res.body.data.optionKey).toBe(optKey);
    expect(res.body.data.axis).toBe("A");
    optionId = res.body.data.id;
  });

  it("POST /admin/value-driver-options returns 409 on duplicate axis+option_key", async () => {
    const res = await adminReq().post("/api/admin/value-driver-options")
      .send({ axis: "A", option_key: "rarity", label: "Duplicate" });
    expect(res.status).toBe(409);
  });

  it("DELETE /admin/value-driver-options/:id returns 404 for unknown", async () => {
    const res = await adminReq().delete("/api/admin/value-driver-options/999999");
    expect(res.status).toBe(404);
  });

  it("DELETE /admin/value-driver-options/:id removes the option", async () => {
    expect(optionId).toBeDefined();
    const res = await adminReq().delete(`/api/admin/value-driver-options/${optionId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify it's gone from the catalogue
    const catalogue = await request(app).get("/api/dex/value-driver-options");
    const axisOpts = catalogue.body.data.A || [];
    expect(axisOpts.some((o) => o.id === optionId)).toBe(false);
  });
});
