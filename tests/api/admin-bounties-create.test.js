'use strict';

// Unit 3.6 — POST /api/admin/bounties (manual bounty creation; flag can_edit_bricks).
// Creates one OPEN bounty_instances row for a brick + bounty type, deriving
// target_field from the definition (the same FIELD_MAP the auto-generator uses)
// and respecting the unique_open_bounty partial index (duplicate OPEN -> 409).
// Reuses the 3.1 admin pattern (createFreshAdmin + adminReq, both auth paths).

const request = require('supertest');
const { app, createFreshAdmin, createFreshUser, adminReq } = require('../helpers/dex');
const {
  prisma, createBrick, cleanup,
} = require('../services/bounties/helpers');

const BASE = '/api/admin/bounties';
const DUMMY_BRICK = 'no-such-brick-3f9a';

let admin;
let plain;
let inactiveDefId;
const INACTIVE_TYPE = `TEST_INACTIVE_${Date.now()}`;

async function openInstances(brickId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, target_field, status, bounty_definition_id FROM bounty_instances
     WHERE brick_id = $1 AND status = 'OPEN'`,
    brickId
  );
}

beforeAll(async () => {
  admin = await createFreshAdmin('u36admin');
  plain = await createFreshUser('u36plain');
  // Throwaway INACTIVE definition (novel unique type, is_active=false) so the
  // inactive branch is provable WITHOUT mutating a seeded global definition row
  // (which would race parallel suites). Ignored by listActive/generateForBrick.
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bounty_definitions (type, display_name, priority, is_active)
     VALUES ($1, 'Test Inactive', 'LOW', FALSE) RETURNING id`,
    INACTIVE_TYPE
  );
  inactiveDefId = rows[0].id;
});

afterAll(async () => {
  if (inactiveDefId) {
    await prisma.$executeRawUnsafe(`DELETE FROM bounty_definitions WHERE id = $1::uuid`, inactiveDefId);
  }
  await cleanup();
});

describe('POST /api/admin/bounties — auth (both paths)', () => {
  test('401 when unauthenticated', async () => {
    const res = await request(app).post(BASE).send({ brickId: DUMMY_BRICK, type: 'PACKAGING_BACK' });
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT (through requirePermission can_edit_bricks)', async () => {
    const res = await request(app).post(BASE)
      .set('Authorization', `Bearer ${plain.token}`)
      .send({ brickId: DUMMY_BRICK, type: 'PACKAGING_BACK' });
    expect(res.status).toBe(403);
  });

  test('201 via admin JWT (hasPermission path)', async () => {
    const brickId = await createBrick({ tag: 'u36jwt' });
    const res = await request(app).post(BASE)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ brickId, type: 'PACKAGING_BACK' });
    expect(res.status).toBe(201);
    expect(res.body.data.instance.status).toBe('OPEN');
  });

  test('201 via X-Admin-Secret (transport path)', async () => {
    const brickId = await createBrick({ tag: 'u36secret' });
    const res = await adminReq().post(BASE).send({ brickId, type: 'SIDE_VIEW' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/admin/bounties — behavior', () => {
  test('creates an OPEN instance with the correct brick, definition, and derived target_field', async () => {
    const brickId = await createBrick({ tag: 'u36create' });
    const res = await adminReq().post(BASE).send({ brickId, type: 'PACKAGING_BACK' });
    expect(res.status).toBe(201);

    const inst = res.body.data.instance;
    expect(inst.status).toBe('OPEN');
    expect(inst.brickId).toBe(brickId);
    expect(inst.targetField).toBe('packaging_back_image_url'); // FIELD_MAP derivation
    expect(inst.bountyDefinitionId).toBeTruthy();
    expect(inst.createdBy).toBe('ADMIN');

    // Verify the row landed as OPEN in the DB.
    const open = await openInstances(brickId);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(inst.id);
    expect(open[0].target_field).toBe('packaging_back_image_url');
    expect(open[0].bounty_definition_id).toBe(inst.bountyDefinitionId);
  });

  test('duplicate OPEN for the same brick+field -> 409', async () => {
    const brickId = await createBrick({ tag: 'u36dup' });
    const first = await adminReq().post(BASE).send({ brickId, type: 'BOTTOM_STAMP' });
    expect(first.status).toBe(201);

    const second = await adminReq().post(BASE).send({ brickId, type: 'BOTTOM_STAMP' });
    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);

    // Still exactly one OPEN instance for that field.
    const open = (await openInstances(brickId)).filter((i) => i.target_field === 'bottom_stamp_image_url');
    expect(open).toHaveLength(1);
  });

  test('unknown brick -> 404', async () => {
    const res = await adminReq().post(BASE).send({ brickId: DUMMY_BRICK, type: 'PACKAGING_BACK' });
    expect(res.status).toBe(404);
  });

  test('unknown bounty type (no such definition) -> 404', async () => {
    const brickId = await createBrick({ tag: 'u36unknowndef' });
    const res = await adminReq().post(BASE).send({ brickId, type: 'TOTALLY_UNKNOWN_TYPE' });
    expect(res.status).toBe(404);
  });

  test('existing-but-inactive definition -> 422 (distinct from unknown)', async () => {
    const brickId = await createBrick({ tag: 'u36inactive' });
    const res = await adminReq().post(BASE).send({ brickId, type: INACTIVE_TYPE });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    // No instance was created.
    expect(await openInstances(brickId)).toHaveLength(0);
  });

  test('malformed body (missing brickId / type) -> 422 with errors', async () => {
    const noType = await adminReq().post(BASE).send({ brickId: DUMMY_BRICK });
    expect(noType.status).toBe(422);
    expect(noType.body.errors.type).toBeDefined();

    const noBrick = await adminReq().post(BASE).send({ type: 'PACKAGING_BACK' });
    expect(noBrick.status).toBe(422);
    expect(noBrick.body.errors.brickId).toBeDefined();
  });
});
