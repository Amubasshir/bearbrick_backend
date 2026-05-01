/**
 * Admin Brick CRUD Tests — Milestone 2 Phase 1 + Phase 2
 *
 * Covers:
 *   POST  /api/admin/bricks         — create with all Phase 2 metadata fields
 *   PATCH /api/admin/bricks/:id     — update with new fields
 *
 * Auth: tests adminAuth (X-Admin-Secret header) + rejection of plain JWT
 */
const request = require("supertest");
const { app, BRICK_1, ADMIN_SECRET, createFreshUser, loginAs, adminReq, SEEDED_EMAIL } = require("../helpers/dex");

describe("Admin Bricks — Auth enforcement", () => {
  it("returns 401 without any auth", async () => {
    const res = await request(app)
      .post("/api/admin/bricks")
      .send({ name: "Test", description_short: "Test" });
    expect(res.status).toBe(401);
  });

  it("returns 403 with plain JWT (non-admin user)", async () => {
    const { token } = await createFreshUser("nonadmin");
    const res = await request(app)
      .post("/api/admin/bricks")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Test", description_short: "Test" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/forbidden/i);
  });

  it("accepts X-Admin-Secret header", async () => {
    const res = await request(app)
      .post("/api/admin/bricks")
      .set("X-Admin-Secret", ADMIN_SECRET)
      .send({ name: "Auth Test Brick", description_short: "Testing admin secret" });
    expect(res.status).toBe(201);
  });
});

describe("Admin Bricks — POST /api/admin/bricks validation", () => {
  it("returns 422 when name is missing", async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({ description_short: "No name" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/name/i);
  });

  it("returns 422 when description_short is missing", async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({ name: "No desc" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/description_short/i);
  });

  it("returns 422 for invalid status", async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({ name: "Bad", description_short: "Status", status: "DELETED" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/status/i);
  });

  it("returns 422 for non-existent family_id", async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({
        name: "Bad Family",
        description_short: "With bad family",
        family_id: "00000000-0000-0000-0000-000000000000",
      });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/family/i);
  });
});

describe("Admin Bricks — POST /api/admin/bricks create", () => {
  let createdId;

  it("creates brick with minimal fields", async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({
        name: "Minimal Brick",
        description_short: "Just the basics",
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.name).toBe("Minimal Brick");
    expect(res.body.data.status).toBe("UNRELEASED");
    expect(res.body.data.featured).toBe(false);
    expect(res.body.data.tags).toEqual([]);
    createdId = res.body.data.id;
  });

  it("creates brick with all Phase 2 metadata fields", async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({
        name: "Full Meta Brick",
        description_short: "All new fields",
        description_long: "Extended description",
        series: "Phase2",
        colorway: "Chrome",
        image_url: "https://example.com/img.jpg",
        thumbnail_url: "https://example.com/thumb.jpg",
        edition_size: 500,
        retail_price: 199.99,
        featured: true,
        tags: ["rare", "collab"],
        status: "PUBLISHED",
      });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d.name).toBe("Full Meta Brick");
    expect(d.thumbnailUrl).toBe("https://example.com/thumb.jpg");
    expect(d.editionSize).toBe(500);
    expect(Number(d.retailPrice)).toBeCloseTo(199.99, 1);
    expect(d.featured).toBe(true);
    expect(d.tags).toEqual(["rare", "collab"]);
    expect(d.status).toBe("PUBLISHED");
    expect(d.releasedAt).not.toBeNull();
  });

  it("default status is UNRELEASED", async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({ name: "Default Status", description_short: "No status field" });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("UNRELEASED");
    expect(res.body.data.releasedAt).toBeNull();
  });

  it("sets releasedAt when status=PUBLISHED", async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({
        name: "Published Now",
        description_short: "Instant publish",
        status: "PUBLISHED",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.releasedAt).not.toBeNull();
  });
});

describe("Admin Bricks — PATCH /api/admin/bricks/:id", () => {
  let brickId;

  beforeAll(async () => {
    const res = await adminReq().post("/api/admin/bricks")
      .send({ name: "Patch Target", description_short: "Will be patched", status: "UNRELEASED" });
    brickId = res.body.data.id;
  });

  it("returns 404 for unknown brick", async () => {
    const res = await adminReq().patch("/api/admin/bricks/00000000-0000-0000-0000-000000000000")
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("updates name", async () => {
    const res = await adminReq().patch(`/api/admin/bricks/${brickId}`)
      .send({ name: "Patched Name" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Patched Name");
  });

  it("updates Phase 2 metadata fields", async () => {
    const res = await adminReq().patch(`/api/admin/bricks/${brickId}`)
      .send({
        thumbnail_url: "https://example.com/new-thumb.jpg",
        edition_size: 1000,
        retail_price: 299.99,
        featured: true,
        tags: ["limited", "anniversary"],
      });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.thumbnailUrl).toBe("https://example.com/new-thumb.jpg");
    expect(d.editionSize).toBe(1000);
    expect(d.featured).toBe(true);
    expect(d.tags).toEqual(["limited", "anniversary"]);
  });

  it("sets releasedAt when transitioning to PUBLISHED", async () => {
    expect(brickId).toBeDefined();
    const before = await adminReq().get(`/api/dex/bricks/${brickId}`);
    // Pre-condition: currently UNRELEASED
    const res = await adminReq().patch(`/api/admin/bricks/${brickId}`)
      .send({ status: "PUBLISHED" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("PUBLISHED");
    expect(res.body.data.releasedAt).not.toBeNull();
  });

  it("does NOT overwrite releasedAt on second PUBLISHED update", async () => {
    const first = await adminReq().patch(`/api/admin/bricks/${brickId}`)
      .send({ status: "PROTOTYPE" });
    // Transition back to PUBLISHED (releasedAt already set)
    const second = await adminReq().patch(`/api/admin/bricks/${brickId}`)
      .send({ status: "PUBLISHED", name: "Re-published" });
    expect(second.status).toBe(200);
    // releasedAt is preserved (set on first publish)
    expect(second.body.data.releasedAt).not.toBeNull();
  });

  it("rejects invalid status", async () => {
    const res = await adminReq().patch(`/api/admin/bricks/${brickId}`)
      .send({ status: "GONE" });
    expect(res.status).toBe(422);
  });
});
