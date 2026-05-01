const request = require("supertest");
const app = require("../../src/app");

const SEEDED_EMAIL = "admin@example.com";
const SEEDED_PASSWORD = "password123";
const SEEDED_BRICK_ID = "11111111-1111-4111-8111-111111111101";

function getAuthToken() {
  return request(app)
    .post("/api/login")
    .send({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD })
    .then((res) => res.body.data?.token);
}

describe("Vote Intents API", () => {
  describe("POST /api/vote_intents", () => {
    it("returns 401 without token", async () => {
      const res = await request(app)
        .post("/api/vote_intents")
        .send({ brick_id: SEEDED_BRICK_ID, vote_type: "FAIR" });
      expect(res.status).toBe(401);
    });

    it("returns 422 when brick_id is missing", async () => {
      const token = await getAuthToken();
      const res = await request(app)
        .post("/api/vote_intents")
        .set("Authorization", `Bearer ${token}`)
        .send({ vote_type: "FAIR" });
      expect(res.status).toBe(422);
      expect(res.body.errors.brick_id).toBeDefined();
    });

    it("returns 422 when vote_type is missing", async () => {
      const token = await getAuthToken();
      const res = await request(app)
        .post("/api/vote_intents")
        .set("Authorization", `Bearer ${token}`)
        .send({ brick_id: SEEDED_BRICK_ID });
      expect(res.status).toBe(422);
      expect(res.body.errors.vote_type).toBeDefined();
    });

    it("returns 422 when vote_type is invalid", async () => {
      const token = await getAuthToken();
      const res = await request(app)
        .post("/api/vote_intents")
        .set("Authorization", `Bearer ${token}`)
        .send({ brick_id: SEEDED_BRICK_ID, vote_type: "INVALID" });
      expect(res.status).toBe(422);
      expect(res.body.errors.vote_type).toBeDefined();
    });

    it("returns 422 when brick_id is not a valid UUID", async () => {
      const token = await getAuthToken();
      const res = await request(app)
        .post("/api/vote_intents")
        .set("Authorization", `Bearer ${token}`)
        .send({ brick_id: "not-a-uuid", vote_type: "FAIR" });
      expect(res.status).toBe(422);
      expect(res.body.errors.brick_id).toBeDefined();
    });

    it("returns 201 and ACCEPTED for valid intent", async () => {
      const token = await getAuthToken();
      const res = await request(app)
        .post("/api/vote_intents")
        .set("Authorization", `Bearer ${token}`)
        .send({
          brick_id: SEEDED_BRICK_ID,
          vote_type: "UNDER",
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ACCEPTED");
      expect(res.body.data.intent_id).toBeDefined();
    });
  });
});
