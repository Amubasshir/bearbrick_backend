'use strict';

const { prisma, createBrick, cleanup } = require('./helpers');
const Inst = require('../../../src/services/bounties/BountyInstanceService');

afterAll(cleanup);

describe('BountyInstanceService (DB)', () => {
  test('generates 8 open bounties for a fully-missing brick, idempotently', async () => {
    const brickId = await createBrick({});
    const brick = await Inst.getBrickForGeneration(prisma, brickId);

    expect(await Inst.generateForBrick(prisma, brick)).toBe(8);
    expect(await Inst.generateForBrick(prisma, brick)).toBe(0); // rerun is a no-op
    expect(await Inst.countOpenForBrick(prisma, brickId)).toBe(8);
  });

  test('skips a field that is already filled', async () => {
    const brickId = await createBrick({ fields: { release_year: 2023, notes: 'hi' } });
    const brick = await Inst.getBrickForGeneration(prisma, brickId);
    expect(await Inst.generateForBrick(prisma, brick)).toBe(6); // 8 - release_year - notes
  });

  test('closeFilledForBrick closes a bounty once its field is filled (Q13)', async () => {
    const brickId = await createBrick({});
    let brick = await Inst.getBrickForGeneration(prisma, brickId);
    await Inst.generateForBrick(prisma, brick);

    await prisma.$executeRawUnsafe(`UPDATE bricks SET notes = 'filled directly' WHERE id = $1`, brickId);
    brick = await Inst.getBrickForGeneration(prisma, brickId);

    expect(await Inst.closeFilledForBrick(prisma, brick)).toBe(1);
    expect(await Inst.countOpenForBrick(prisma, brickId)).toBe(7);
  });

  test('closeInstanceIfFieldFilled closes only when the field is present', async () => {
    const brickId = await createBrick({});
    let brick = await Inst.getBrickForGeneration(prisma, brickId);
    await Inst.generateForBrick(prisma, brick);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT bi.id FROM bounty_instances bi
       JOIN bounty_definitions bd ON bd.id = bi.bounty_definition_id
       WHERE bi.brick_id = $1 AND bd.type = 'SIDE_VIEW' LIMIT 1`, brickId);
    const instId = rows[0].id;

    // Field still null -> no close.
    expect((await Inst.closeInstanceIfFieldFilled(prisma, instId)).closed).toBe(false);

    await prisma.$executeRawUnsafe(`UPDATE bricks SET side_image_url = 'https://x/side.png' WHERE id = $1`, brickId);
    const res = await Inst.closeInstanceIfFieldFilled(prisma, instId);
    expect(res.closed).toBe(true);
    expect(res.brickId).toBe(brickId);
  });
});
