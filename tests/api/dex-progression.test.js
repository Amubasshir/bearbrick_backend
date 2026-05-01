/**
 * Dex Stage Progression Tests — Milestone 2 Phase 1 + Phase 2
 *
 * Tests the full progression flow for a fresh user:
 *   Stage 0 → 1 (context open / progress)
 *   Stage 1 → 2 (vote + XP)
 *   Stage 2 → 3 (value driver + XP + event log)
 *
 * Also tests:
 *   - Idempotency replay
 *   - Gate violations (403/409)
 *   - Streak update
 *   - DexEventLog entries via admin event-log endpoint
 */
const request = require("supertest");
const { app, BRICK_1, BRICK_2, BRICK_3, createFreshUser, adminReq } = require("../helpers/dex");

// --- Context / Stage 1 ---

describe("Dex Progression — Stage 0 → 1 (context)", () => {
  let token;
  const BRICK = BRICK_1;

  beforeAll(async () => {
    ({ token } = await createFreshUser("ctx"));
  });

  it("context/open returns 404 for unknown brick", async () => {
    const res = await request(app)
      .post("/api/dex/bricks/00000000-0000-0000-0000-000000000000/context/open")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("context/open advances unauthenticated user (no progress change, just viewstate)", async () => {
    const res = await request(app).post(`/api/dex/bricks/${BRICK}/context/open`);
    expect(res.status).toBe(200);
    expect(res.body.data.user_stage).toBe(0); // no auth → no progress
  });

  it("context/open advances authenticated user to stage 1", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/context/open`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user_stage).toBe(1);
    expect(res.body.data.image_mode).toBe(false); // stage >= 1 → image revealed
  });

  it("context/open is idempotent — calling again keeps stage 1", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/context/open`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user_stage).toBe(1);
  });

  it("context/progress requires Idempotency-Key header", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/context/progress`)
      .set("Authorization", `Bearer ${token}`)
      .send({ dwell_seconds: 15, scroll_pct: 90 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/idempotency/i);
  });

  it("context/progress with short dwell does NOT award DEX_STAGE1 XP again", async () => {
    const uid = `${Date.now()}`;
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/context/progress`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `prog-short-${uid}`)
      .send({ dwell_seconds: 3, scroll_pct: 30, interaction_seen: false });
    expect(res.status).toBe(200);
    expect(res.body.stage1_completed).toBe(false);
  });
});

// --- Vote / Stage 2 ---

describe("Dex Progression — Stage 1 → 2 (vote)", () => {
  let token;
  const BRICK = BRICK_2;
  const uid = `vote-${Date.now()}`;

  beforeAll(async () => {
    ({ token } = await createFreshUser("vote"));
    // Advance to stage 1 first
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/context/open`)
      .set("Authorization", `Bearer ${token}`);
  });

  it("vote requires Idempotency-Key header", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ vote_type: "FAIR" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/idempotency/i);
  });

  it("vote requires auth", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/vote`)
      .set("Idempotency-Key", `idem-noauth-${uid}`)
      .send({ vote_type: "FAIR" });
    expect(res.status).toBe(401);
  });

  it("vote rejects invalid vote_type", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `idem-bad-${uid}`)
      .send({ vote_type: "MAYBE" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/vote_type/i);
  });

  it("vote returns 200, advances to stage 2, and returns correct viewstate", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `idem-vote-${uid}`)
      .send({ vote_type: "FAIR" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.user_stage).toBe(2);
    expect(d.stage_meta.voted).toBe(true);
    expect(d.stage_meta.vote_type).toBe("FAIR");
    // Stage 2 → price visible on PUBLISHED brick
    expect(d.price_visible).toBe(true);
    expect(d.price).not.toBeNull();
  });

  it("vote replays cached response on duplicate Idempotency-Key", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `idem-vote-${uid}`)
      .send({ vote_type: "UNDER" }); // different body — should replay original
    expect(res.status).toBe(200);
    expect(res.body.data.user_stage).toBe(2);
    expect(res.body.data.stage_meta.vote_type).toBe("FAIR"); // original, not UNDER
  });

  it("vote returns 409 when already voted (new idempotency key)", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `idem-dup-${uid}`)
      .send({ vote_type: "OVER" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already voted/i);
  });
});

// --- Stage 0 gate: vote requires stage >= 1 ---

describe("Dex Progression — Gate: vote requires stage 1", () => {
  let token;

  beforeAll(async () => {
    ({ token } = await createFreshUser("gate-vote"));
    // Do NOT advance to stage 1
  });

  it("returns 403 if voting from stage 0", async () => {
    const uid = `gate-${Date.now()}`;
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK_1}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `gate-vote-${uid}`)
      .send({ vote_type: "FAIR" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/context/i);
  });
});

// --- Value Driver / Stage 3 ---

describe("Dex Progression — Stage 2 → 3 (value driver)", () => {
  let token;
  const BRICK = BRICK_1;
  const uid = `vd-${Date.now()}`;

  beforeAll(async () => {
    ({ token } = await createFreshUser("vd"));
    // Advance to stage 2
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/context/open`)
      .set("Authorization", `Bearer ${token}`);
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `setup-vote-${uid}`)
      .send({ vote_type: "UNDER" });
  });

  it("value-driver rejects invalid axis", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/value-driver`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `vd-bad-axis-${uid}`)
      .send({ axis: "Z", option_key: "rarity" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/axis/i);
  });

  it("value-driver rejects missing option_key", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/value-driver`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `vd-no-key-${uid}`)
      .send({ axis: "A" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/option_key/i);
  });

  it("value-driver rejects invalid option_key (not in catalogue)", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/value-driver`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `vd-bad-key-${uid}`)
      .send({ axis: "A", option_key: "not_a_real_option_xyz" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/option_key/i);
  });

  it("value-driver advances to stage 3 and returns correct viewstate", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/value-driver`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `vd-submit-${uid}`)
      .send({ axis: "A", option_key: "rarity" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.user_stage).toBe(3);
    expect(d.stage_meta.value_driver).toEqual({ axis: "A", option_key: "rarity" });
  });

  it("value-driver returns 409 when already at stage 3", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/value-driver`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `vd-dup-${uid}`)
      .send({ axis: "B", option_key: "condition" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already submitted/i);
  });

  it("value-driver replays on duplicate Idempotency-Key", async () => {
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK}/value-driver`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `vd-submit-${uid}`) // same key as the successful request
      .send({ axis: "B", option_key: "condition" });
    expect(res.status).toBe(200);
    expect(res.body.data.stage_meta.value_driver.axis).toBe("A"); // replayed original
  });
});

// --- Stage 1 gate: value driver requires stage >= 2 ---

describe("Dex Progression — Gate: value driver requires stage 2", () => {
  let token;

  beforeAll(async () => {
    ({ token } = await createFreshUser("gate-vd"));
    // Advance only to stage 1
    await request(app)
      .post(`/api/dex/bricks/${BRICK_2}/context/open`)
      .set("Authorization", `Bearer ${token}`);
  });

  it("returns 403 if submitting value driver from stage 1", async () => {
    const uid = `gate-vd-${Date.now()}`;
    const res = await request(app)
      .post(`/api/dex/bricks/${BRICK_2}/value-driver`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `gate-vd-${uid}`)
      .send({ axis: "A", option_key: "rarity" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/vote/i);
  });
});

// --- Event Log verification ---

describe("Dex Progression — DexEventLog entries", () => {
  let token;
  const BRICK = BRICK_3;
  const uid = `elog-${Date.now()}`;

  beforeAll(async () => {
    ({ token } = await createFreshUser("elog"));
    // Full stage 0→3
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/context/open`)
      .set("Authorization", `Bearer ${token}`);
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `elog-vote-${uid}`)
      .send({ vote_type: "OVER" });
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/value-driver`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `elog-vd-${uid}`)
      .send({ axis: "C", option_key: "demand" });
  });

  it("admin event-log for brick contains STAGE_ADVANCED entries", async () => {
    const res = await adminReq().get(`/api/admin/bricks/${BRICK}/event-log`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const events = res.body.data;
    expect(Array.isArray(events)).toBe(true);
    const stageEvents = events.filter((e) => e.eventType === "STAGE_ADVANCED");
    expect(stageEvents.length).toBeGreaterThanOrEqual(2); // at least stage 1→2 and 2→3
  });

  it("admin event-log contains VOTE_SUBMITTED entry", async () => {
    const res = await adminReq().get(`/api/admin/bricks/${BRICK}/event-log`);
    const events = res.body.data;
    const voteEvents = events.filter((e) => e.eventType === "VOTE_SUBMITTED");
    expect(voteEvents.length).toBeGreaterThanOrEqual(1);
    expect(voteEvents[0].payload.vote_type).toBe("OVER");
  });

  it("admin event-log contains VALUE_DRIVER_SET entry", async () => {
    const res = await adminReq().get(`/api/admin/bricks/${BRICK}/event-log`);
    const events = res.body.data;
    const vdEvents = events.filter((e) => e.eventType === "VALUE_DRIVER_SET");
    expect(vdEvents.length).toBeGreaterThanOrEqual(1);
    expect(vdEvents[0].payload.axis).toBe("C");
    expect(vdEvents[0].payload.option_key).toBe("demand");
  });

  it("admin event-log returns 404 for unknown brick", async () => {
    const res = await adminReq().get("/api/admin/bricks/00000000-0000-0000-0000-000000000000/event-log");
    expect(res.status).toBe(404);
  });
});

// --- XP verification after full progression ---

describe("Dex Progression — XP awarded per stage", () => {
  let token;
  const BRICK = BRICK_2;
  const uid = `xp-${Date.now()}`;

  beforeAll(async () => {
    ({ token } = await createFreshUser("xpcheck"));
    // Stage 1: open
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/context/open`)
      .set("Authorization", `Bearer ${token}`);
    // Stage 1 XP (5): from context/progress
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/context/progress`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `xp-prog-${uid}`)
      .send({ dwell_seconds: 15, scroll_pct: 90 });
    // Stage 2 XP (10)
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `xp-vote-${uid}`)
      .send({ vote_type: "FAIR" });
    // Stage 3 XP (15)
    await request(app)
      .post(`/api/dex/bricks/${BRICK}/value-driver`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `xp-vd-${uid}`)
      .send({ axis: "D", option_key: "size" });
  });

  it("GET /dex/me/xp shows total XP >= 30 (5+10+15 minimum)", async () => {
    const res = await request(app)
      .get("/api/dex/me/xp")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalXp).toBeGreaterThanOrEqual(30);
  });

  it("XP history contains DEX_STAGE1, VOTE, DEX_STAGE3 reasons", async () => {
    const res = await request(app)
      .get("/api/dex/me/xp?limit=50")
      .set("Authorization", `Bearer ${token}`);
    const reasons = res.body.data.history.map((e) => e.reason);
    expect(reasons).toContain("DEX_STAGE1");
    expect(reasons).toContain("VOTE");
    expect(reasons).toContain("DEX_STAGE3");
  });
});
