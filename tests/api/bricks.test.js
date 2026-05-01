const request = require("supertest");
const app = require("../../src/app");

const SEEDED_BRICK_ID = "11111111-1111-4111-8111-111111111101";

describe("Bricks API", () => {
  describe("GET /api/bricks/:brick_id/state", () => {
    it("returns 404 for unknown brick_id", async () => {
      const res = await request(app).get(
        "/api/bricks/00000000-0000-0000-0000-000000000000/state",
      );
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/not found/i);
    });

    it("returns 200 and state without auth (no sentiment)", async () => {
      const res = await request(app).get(
        `/api/bricks/${SEEDED_BRICK_ID}/state`,
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.brick_id).toBe(SEEDED_BRICK_ID);
      expect(res.body.data.live_price).toBeDefined();
      expect(res.body.data.fair_lower).toBeDefined();
      expect(res.body.data.fair_upper).toBeDefined();
      expect(res.body.data.freeze_mode).toBe(false);
      expect(res.body.data.current_cycle_id).toBeDefined();
      expect(res.body.data.last_vote_event_id_processed).toBeDefined();
      expect(res.body.data.p_under).toBeUndefined();
      expect(res.body.data.p_fair).toBeUndefined();
      expect(res.body.data.p_over).toBeUndefined();
      expect(res.body.data.pricing_confidence_c).toBeUndefined();
    });

    it("returns same state with invalid token (optionalAuth)", async () => {
      const res = await request(app)
        .get(`/api/bricks/${SEEDED_BRICK_ID}/state`)
        .set("Authorization", "Bearer invalid");
      expect(res.status).toBe(200);
      expect(res.body.data.brick_id).toBe(SEEDED_BRICK_ID);
    });
  });
});
