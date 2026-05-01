/**
 * Dex Catalogue Tests — Phase 1 + Phase 2
 *
 * Covers:
 *   GET  /api/dex/bricks                  — list with filters
 *   GET  /api/dex/bricks/featured         — featured flag filter
 *   GET  /api/dex/bricks/:id              — single brick
 *   GET  /api/dex/bricks/:id/stats        — per-brick engagement stats
 *   GET  /api/dex/search?q=               — FTS search with filters
 *   GET  /api/dex/value-driver-options    — VDO catalogue grouped by axis
 *   GET  /api/dex/stats/global            — global catalogue stats
 */
const request = require("supertest");
const { app, BRICK_1, BRICK_2, BRICK_3, adminReq } = require("../helpers/dex");

describe("Dex Catalogue — GET /api/dex/bricks", () => {
  it("returns 200 with paginated list", async () => {
    const res = await request(app).get("/api/dex/bricks");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(5);
  });

  it("excludes PROTOTYPE bricks by default", async () => {
    const res = await request(app).get("/api/dex/bricks");
    expect(res.status).toBe(200);
    for (const brick of res.body.data) {
      expect(brick.status).not.toBe("PROTOTYPE");
    }
  });

  it("returns BrickViewState shape for each brick", async () => {
    const res = await request(app).get("/api/dex/bricks?limit=1");
    expect(res.status).toBe(200);
    const brick = res.body.data[0];
    expect(brick).toHaveProperty("brick_id");
    expect(brick).toHaveProperty("status");
    expect(brick).toHaveProperty("image_mode");
    expect(brick).toHaveProperty("price_visible");
    expect(brick).toHaveProperty("user_stage");
    // Unauthenticated: stage 0, image_mode = true for PUBLISHED bricks
    expect(brick.user_stage).toBe(0);
    expect(brick.image_mode).toBe(true);
  });

  it("filters by ?status=PUBLISHED", async () => {
    const res = await request(app).get("/api/dex/bricks?status=PUBLISHED");
    expect(res.status).toBe(200);
    for (const brick of res.body.data) {
      expect(brick.status).toBe("PUBLISHED");
    }
  });

  it("filters by ?series=Series+1", async () => {
    const res = await request(app).get("/api/dex/bricks?series=Series+1");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    // All returned bricks should have series = 'Series 1' in their full data
    // (image_mode may hide name but not series in the raw response — we check count >= 2 from seed)
  });

  it("respects pagination ?page and ?limit", async () => {
    const page1 = await request(app).get("/api/dex/bricks?page=1&limit=2");
    const page2 = await request(app).get("/api/dex/bricks?page=2&limit=2");
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page1.body.data.length).toBeLessThanOrEqual(2);
    const ids1 = page1.body.data.map((b) => b.brick_id);
    const ids2 = page2.body.data.map((b) => b.brick_id);
    // No overlap between pages
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });
});

describe("Dex Catalogue — GET /api/dex/bricks/featured", () => {
  beforeAll(async () => {
    // Set brick_1 as featured via admin
    await adminReq().patch(`/api/admin/bricks/${BRICK_1}/feature`).send({ featured: true });
  });

  afterAll(async () => {
    // Reset
    await adminReq().patch(`/api/admin/bricks/${BRICK_1}/feature`).send({ featured: false });
  });

  it("returns only featured bricks", async () => {
    const res = await request(app).get("/api/dex/bricks/featured");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((b) => b.brick_id === BRICK_1)).toBe(true);
  });

  it("?featured=true on /dex/bricks also returns featured", async () => {
    const res = await request(app).get("/api/dex/bricks?featured=true");
    expect(res.status).toBe(200);
    expect(res.body.data.some((b) => b.brick_id === BRICK_1)).toBe(true);
  });
});

describe("Dex Catalogue — GET /api/dex/bricks/:id", () => {
  it("returns 404 for unknown brick", async () => {
    const res = await request(app).get("/api/dex/bricks/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 with BrickViewState for seeded brick", async () => {
    const res = await request(app).get(`/api/dex/bricks/${BRICK_1}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.brick_id).toBe(BRICK_1);
    expect(res.body.data.status).toBe("PUBLISHED");
    expect(res.body.data.user_stage).toBe(0);
    expect(res.body.data.image_mode).toBe(true); // stage 0 → image mode
    expect(res.body.data.price_visible).toBe(false);
    expect(res.body.data.stage_meta).toBeNull();
  });
});

describe("Dex Catalogue — GET /api/dex/bricks/:id/stats", () => {
  it("returns 404 for unknown brick", async () => {
    const res = await request(app).get("/api/dex/bricks/00000000-0000-0000-0000-000000000000/stats");
    expect(res.status).toBe(404);
  });

  it("returns 200 with engagement counts and value driver breakdown", async () => {
    const res = await request(app).get(`/api/dex/bricks/${BRICK_1}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(typeof d.unique_users_opened).toBe("number");
    expect(typeof d.unique_users_voted).toBe("number");
    expect(typeof d.unique_users_completed).toBe("number");
    expect(Array.isArray(d.value_driver_breakdown)).toBe(true);
  });
});

describe("Dex Catalogue — GET /api/dex/search", () => {
  it("returns 400 when q is missing", async () => {
    const res = await request(app).get("/api/dex/search");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 200 with FTS results for 'black'", async () => {
    const res = await request(app).get("/api/dex/search?q=black");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("returns 200 with empty array for unmatched query", async () => {
    const res = await request(app).get("/api/dex/search?q=zzzznosuchthing99");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns BrickViewState shape per result", async () => {
    const res = await request(app).get("/api/dex/search?q=series");
    expect(res.status).toBe(200);
    if (res.body.data.length > 0) {
      const b = res.body.data[0];
      expect(b).toHaveProperty("brick_id");
      expect(b).toHaveProperty("image_mode");
      expect(b).toHaveProperty("user_stage");
    }
  });

  it("filters by ?status=PUBLISHED", async () => {
    const res = await request(app).get("/api/dex/search?q=series&status=PUBLISHED");
    expect(res.status).toBe(200);
    for (const b of res.body.data) {
      expect(b.status).toBe("PUBLISHED");
    }
  });
});

describe("Dex — GET /api/dex/value-driver-options", () => {
  it("returns 200 with options grouped by axis A/B/C/D", async () => {
    const res = await request(app).get("/api/dex/value-driver-options");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d).toHaveProperty("A");
    expect(d).toHaveProperty("B");
    expect(d).toHaveProperty("C");
    expect(d).toHaveProperty("D");
    expect(Array.isArray(d.A)).toBe(true);
    expect(d.A.length).toBeGreaterThanOrEqual(1);
    // Each option has option_key and label
    const opt = d.A[0];
    expect(opt).toHaveProperty("option_key");
    expect(opt).toHaveProperty("label");
  });
});

describe("Dex — GET /api/dex/stats/global", () => {
  it("returns 200 with global stats", async () => {
    const res = await request(app).get("/api/dex/stats/global");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(typeof d.total_bricks_published).toBe("number");
    expect(typeof d.total_completions).toBe("number");
    expect(d.total_bricks_published).toBeGreaterThanOrEqual(5);
  });
});
