const request = require("supertest");
const app = require("../../src/app");

const SEEDED_EMAIL = "admin@example.com";
const SEEDED_PASSWORD = "password123";

describe("Auth API", () => {
  describe("POST /api/login", () => {
    it("returns 422 when email is missing", async () => {
      const res = await request(app)
        .post("/api/login")
        .send({ password: "password123" });
      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.errors.email).toBeDefined();
    });

    it("returns 422 when password is missing", async () => {
      const res = await request(app)
        .post("/api/login")
        .send({ email: "a@b.com" });
      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.errors.password).toBeDefined();
    });

    it("returns 422 when email is invalid", async () => {
      const res = await request(app)
        .post("/api/login")
        .send({ email: "invalid", password: "password123" });
      expect(res.status).toBe(422);
      expect(res.body.errors.email).toBeDefined();
    });

    it("returns 422 when password is too short", async () => {
      const res = await request(app)
        .post("/api/login")
        .send({ email: "a@b.com", password: "12345" });
      expect(res.status).toBe(422);
      expect(res.body.errors.password).toBeDefined();
    });

    it("returns 401 for invalid credentials", async () => {
      const res = await request(app)
        .post("/api/login")
        .send({ email: "wrong@example.com", password: "wrongpass" });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/invalid|credentials/i);
    });

    it("returns 200 and token for valid credentials (seeded user)", async () => {
      const res = await request(app)
        .post("/api/login")
        .send({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Login successful");
      expect(res.body.data).toBeDefined();
      expect(res.body.data.user).toBeDefined();
      expect(res.body.data.user.email).toBe(SEEDED_EMAIL);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.token_type).toBe("Bearer");
    });
  });

  describe("GET /api/me", () => {
    it("returns 401 without token", async () => {
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid token", async () => {
      const res = await request(app)
        .get("/api/me")
        .set("Authorization", "Bearer invalid-token");
      expect(res.status).toBe(401);
    });

    it("returns 200 and user when valid token", async () => {
      const loginRes = await request(app)
        .post("/api/login")
        .send({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD });
      const token = loginRes.body.data.token;
      const res = await request(app)
        .get("/api/me")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe(SEEDED_EMAIL);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.name).toBeDefined();
    });
  });

  describe("POST /api/logout", () => {
    it("returns 401 without token", async () => {
      const res = await request(app).post("/api/logout");
      expect(res.status).toBe(401);
    });

    it("returns 200 with valid token", async () => {
      const loginRes = await request(app)
        .post("/api/login")
        .send({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD });
      const token = loginRes.body.data.token;
      const res = await request(app)
        .post("/api/logout")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Logout successful");
    });
  });
});
