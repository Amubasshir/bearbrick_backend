'use strict';

// LIVE end-to-end smoke (Phase B Unit 5.2) — NOT a jest test, NOT in npm test.
// Makes REAL calls against the real Supabase `bounty-submissions` bucket and the
// real DB, then cleans everything up in a finally block. Run on demand:
//   node scripts/smoke-bounty-upload.js
//
// Stages: setup -> real upload -> object-exists-in-bucket -> signed-URL-resolves
//   -> submit -> admin approve-and-apply (reward moves + canonical write + close).
// Reuses the shipped services/helpers; adds no business logic.

require('dotenv').config();

const https = require('https');
const H = require('../tests/services/bounties/helpers');
const Inst = require('../src/services/bounties/BountyInstanceService');
const Sub = require('../src/services/bounties/BountySubmissionService');
const ApplyService = require('../src/services/bounties/BountyApprovalAndApplyService');
const ImageUploadService = require('../src/services/bounties/ImageUploadService');
const { createBountyStorage } = require('../src/lib/supabaseStorage');

const prisma = H.prisma;

// Minimal valid PNG (magic bytes + IHDR 800x800) — passes imageValidation.
function makePng(width, height, totalBytes = 64) {
  const buf = Buffer.alloc(totalBytes);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((b, i) => { buf[i] = b; });
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const stages = [];
function pass(name, detail = '') { stages.push({ name, ok: true }); console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, msg) { stages.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${msg}`); }

function httpsStatus(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', (e) => resolve('ERR:' + e.code));
  });
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const storage = createBountyStorage({ url, serviceRoleKey });

  let objectPath = null;
  let submitterId = null;
  let brickId = null;

  console.log('LIVE smoke: bounty image upload → submit → approve-and-apply\n');
  try {
    // 1. Setup: verified user + brick + OPEN image bounty.
    submitterId = await H.createUser({ verified: true, tag: 'smoke' });
    brickId = await H.createBrick({ tag: 'smoke' });
    const brick = await Inst.getBrickForGeneration(prisma, brickId);
    await Inst.generateForBrick(prisma, brick);
    const instanceId = await H.instanceIdByType(brickId, 'PACKAGING_BACK');
    if (!instanceId) throw new Error('no PACKAGING_BACK instance generated');
    pass('setup (user + brick + OPEN bounty)', `user=${submitterId} brick=${brickId}`);

    // 2. REAL upload → signed URL.
    const uploaded = await ImageUploadService.upload(storage, { buffer: makePng(800, 800), userId: submitterId });
    objectPath = uploaded.path;
    if (!uploaded.signedUrl || !/bounty-submissions/.test(uploaded.signedUrl)) {
      throw new Error('signedUrl missing / not bucket-scoped: ' + uploaded.signedUrl);
    }
    pass('real upload → signed URL', `path=${objectPath}`);

    // 3. Object actually exists in the bucket (not just a URL string).
    const folder = String(submitterId);
    const listRes = await storage.list(folder);
    if (listRes.error) throw new Error('list error: ' + listRes.error.message);
    const fileName = objectPath.split('/').pop();
    if (!(listRes.data || []).some((o) => o.name === fileName)) {
      throw new Error(`object ${fileName} not found in bucket under ${folder}/`);
    }
    pass('object exists in bucket', `${folder}/${fileName}`);

    // 3b. Signed URL resolves over HTTPS (bonus — non-fatal).
    const status = await httpsStatus(uploaded.signedUrl);
    if (status === 200) pass('signed URL resolves (HTTP 200)');
    else fail('signed URL resolves', 'status=' + status);

    // 4. Submit referencing the signed URL.
    const submission = await Sub.submit(prisma, {
      userId: submitterId, bountyInstanceId: instanceId, submissionType: 'IMAGE', contentUrl: uploaded.signedUrl,
    });
    if (submission.status !== 'PENDING') throw new Error('expected PENDING, got ' + submission.status);
    if (submission.cash_reward_cents !== 75) throw new Error('expected captured 75c, got ' + submission.cash_reward_cents);
    pass('submit → PENDING (reward captured)', `sub=${submission.id} cash=${submission.cash_reward_cents}c`);

    // 5. Admin approve-and-apply → reward moves + canonical write + close.
    const result = await ApplyService.approveAndApply(prisma, { submissionId: submission.id, adminUserId: null });
    const bal = await H.balanceFor(submitterId);
    const xps = (await H.xpEventsFor(submitterId)).map((x) => x.event_type);
    const rewards = await H.rewardEventsFor(submitterId);
    const brickRow = await prisma.$queryRawUnsafe(`SELECT packaging_back_image_url FROM bricks WHERE id = $1`, brickId);
    const instRow = await prisma.$queryRawUnsafe(`SELECT status FROM bounty_instances WHERE id = $1::uuid`, instanceId);

    if (result.submission.status !== 'APPLIED_TO_BRICK') throw new Error('expected APPLIED_TO_BRICK, got ' + result.submission.status);
    if (!bal || bal.cash_balance_cents !== 75 || bal.credit_balance !== 75) throw new Error('balance did not move: ' + JSON.stringify(bal));
    if (!xps.includes('BOUNTY_SUBMISSION_APPROVED')) throw new Error('missing BOUNTY_SUBMISSION_APPROVED xp');
    if (rewards.length < 1) throw new Error('no reward event minted');
    if (brickRow[0].packaging_back_image_url !== uploaded.signedUrl) throw new Error('canonical brick field not written');
    if (instRow[0].status !== 'CLOSED') throw new Error('instance not closed, got ' + instRow[0].status);
    pass('approve-and-apply → reward moved + canonical write + close',
      `cash=${bal.cash_balance_cents}c credits=${bal.credit_balance} xp=[${xps.join(',')}]`);

    console.log('\nSMOKE RESULT: PASS — every stage green against live Supabase.');
  } catch (err) {
    fail('smoke aborted', err && err.message ? err.message : String(err));
    console.log('\nSMOKE RESULT: FAIL — ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    // 6. MANDATORY cleanup — leave the bucket and DB exactly as found.
    console.log('\ncleanup:');
    try {
      if (objectPath) {
        const rm = await storage.remove([objectPath]);
        console.log(rm.error ? `  ! object remove error: ${rm.error.message}` : `  removed bucket object ${objectPath}`);
      }
    } catch (e) { console.log('  ! object remove threw: ' + e.message); }
    try {
      await H.cleanup();
      console.log('  removed DB rows (user/brick/submission/instances/rewards/balance/xp)');
    } catch (e) { console.log('  ! DB cleanup threw: ' + e.message); }
    await prisma.$disconnect();
  }
}

main();
