/**
 * Dex Families Tests — Phase 2
 *
 * Covers:
 *   POST  /api/admin/families          — create family
 *   PATCH /api/admin/families/:id      — update family
 *   GET   /api/dex/families            — list families
 *   GET   /api/dex/families/:slug/bricks — bricks in family
 *   PATCH /api/admin/bricks/:id        — assign familyId (via existing endpoint)
 */
const request = require("supertest");
const { app, BRICK_1, BRICK_2, adminReq, createFreshUser } = require("../helpers/dex");

const slug = `test-family-${Date.now()}`;

describe("Dex Families — Admin CRUD", () => {
  let familyId;

  it("POST /admin/families returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/admin/families")
      .send({ name: "No Auth", slug: "no-auth" });
    expect(res.status).toBe(401);
  });

  it("POST /admin/families returns 422 when name missing", async () => {
    const res = await adminReq().post("/api/admin/families")
      .send({ slug: "missing-name" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/name/i);
  });

  it("POST /admin/families returns 422 when slug missing", async () => {
    const res = await adminReq().post("/api/admin/families")
      .send({ name: "No Slug" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/slug/i);
  });

  it("POST /admin/families creates a family with all fields", async () => {
    const res = await adminReq().post("/api/admin/families")
      .send({
        name: "Test Series Family",
        slug,
        description: "A test family for unit tests",
        cover_image_url: "https://example.com/cover.jpg",
        display_order: 1,
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.name).toBe("Test Series Family");
    expect(d.slug).toBe(slug);
    expect(d.description).toBe("A test family for unit tests");
    expect(d.displayOrder).toBe(1);
    familyId = d.id;
  });

  it("POST /admin/families returns 409 on duplicate slug", async () => {
    const res = await adminReq().post("/api/admin/families")
      .send({ name: "Duplicate Slug", slug });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/slug/i);
  });

  it("PATCH /admin/families/:id returns 404 for unknown family", async () => {
    const res = await adminReq().patch("/api/admin/families/00000000-0000-0000-0000-000000000000")
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("PATCH /admin/families/:id updates name and display_order", async () => {
    const res = await adminReq().patch(`/api/admin/families/${familyId}`)
      .send({ name: "Updated Family Name", display_order: 5 });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Updated Family Name");
    expect(res.body.data.displayOrder).toBe(5);
  });
});

describe("Dex Families — GET /api/dex/families", () => {
  it("returns 200 with list of families", async () => {
    const res = await request(app).get("/api/dex/families");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((f) => f.slug === slug)).toBe(true);
  });

  it("families are ordered by displayOrder then name", async () => {
    const res = await request(app).get("/api/dex/families");
    expect(res.status).toBe(200);
    const orders = res.body.data.map((f) => f.displayOrder);
    // Should be non-decreasing
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThanOrEqual(orders[i - 1]);
    }
  });
});

describe("Dex Families — Assign brick to family and retrieve", () => {
  let familyId;
  let familySlug;

  beforeAll(async () => {
    const uid = Date.now();
    familySlug = `brick-family-${uid}`;
    // Create a fresh family
    const fam = await adminReq().post("/api/admin/families")
      .send({ name: `Brick Family ${uid}`, slug: familySlug });
    familyId = fam.body.data.id;

    // Create a brick and assign to this family
    await adminReq().post("/api/admin/bricks")
      .send({
        name: "Family Brick Test",
        description_short: "In a family",
        status: "PUBLISHED",
        family_id: familyId,
      });
  });

  it("GET /dex/families/:slug/bricks returns 404 for unknown slug", async () => {
    const res = await request(app).get("/api/dex/families/this-slug-does-not-exist/bricks");
    expect(res.status).toBe(404);
  });

  it("GET /dex/families/:slug/bricks lists bricks assigned to family", async () => {
    const res = await request(app).get(`/api/dex/families/${familySlug}/bricks`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.family.slug).toBe(familySlug);
    // Returns BrickViewState shape
    const brick = res.body.data[0];
    expect(brick).toHaveProperty("brick_id");
    expect(brick).toHaveProperty("user_stage");
  });

  it("GET /dex/families/:slug/bricks with auth returns personalized stage", async () => {
    const { token } = await createFreshUser("family-auth");
    const res = await request(app)
      .get(`/api/dex/families/${familySlug}/bricks`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Authenticated user at stage 0 — same data but stage_meta is non-null (but no vote)
    const brick = res.body.data[0];
    expect(brick.stage_meta).toBeDefined();
  });

  it("GET /dex/families/:slug/bricks supports pagination", async () => {
    const res = await request(app).get(`/api/dex/families/${familySlug}/bricks?limit=1`);
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.limit).toBe(1);
  });

  it("PATCH /admin/bricks/:id can update familyId", async () => {
    // Create a brick without a family, then assign
    const created = await adminReq().post("/api/admin/bricks")
      .send({ name: "Orphan Brick", description_short: "No family", status: "PUBLISHED" });
    const brickId = created.body.data.id;

    const res = await adminReq().patch(`/api/admin/bricks/${brickId}`)
      .send({ family_id: familyId });
    expect(res.status).toBe(200);
    expect(res.body.data.familyId).toBe(familyId);
  });
});
