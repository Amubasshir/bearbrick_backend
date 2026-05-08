const AuthService = require("../services/AuthService");
const prisma = require("../lib/prisma");
const { computeLocalDayKey, resolveSessionWindow, toDayKeyString } = require("../lib/sessions");

async function login(req, res) {
  const { email, password } = req.body;
  const errors = {};
  if (!email) errors.email = ["Required"];
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.email = ["Must be a valid email"];
  if (!password) errors.password = ["Required"];
  else if (String(password).length < 6) errors.password = ["Min 6 characters"];
  if (Object.keys(errors).length) {
    return res.status(422).json({
      success: false,
      message: "Validation error",
      errors,
    });
  }
  // Normalize email (trim and lowercase)
  const normalizedEmail = email.trim().toLowerCase();
  const result = await AuthService.login(normalizedEmail, password);
  if (!result.success) {
    return res.status(401).json({ success: false, message: result.message });
  }
  return res.status(200).json({
    success: true,
    message: "Login successful",
    data: result.data,
  });
}

async function logout(req, res) {
  res.json({ success: true, message: "Logout successful" });
}

async function signup(req, res) {
  const { name, email, password, email_verified, timezone, guest_session } = req.body;
  const errors = {};

  if (!name || !name.trim()) errors.name = ["Required"];
  if (!email) errors.email = ["Required"];
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.email = ["Must be a valid email"];
  if (!password) errors.password = ["Required"];
  else if (String(password).length < 6) errors.password = ["Min 6 characters"];

  if (Object.keys(errors).length) {
    return res.status(422).json({
      success: false,
      message: "Validation error",
      errors,
    });
  }

  const emailVerified =
    email_verified === true ||
    email_verified === false ||
    email_verified === 1 ||
    email_verified === "0" ||
    email_verified === "true" ||
    email_verified === "1" ||
    email_verified === "false" ||
    email_verified === "0";

  const result = await AuthService.signup(
    name.trim(),
    email.trim(),
    password,
    emailVerified
  );

  if (!result.success) {
    return res.status(409).json({ success: false, message: result.message });
  }

  const userId = BigInt(result.data.user.id);

  // Persist timezone if provided. Default 'UTC' is set by the DB column default.
  if (timezone && typeof timezone === "string") {
    await prisma.$queryRawUnsafe(
      `UPDATE "User" SET timezone = $2 WHERE id = $1`,
      userId,
      timezone
    );
  }

  // Guest session conversion — silent on failure, never block signup.
  if (guest_session && typeof guest_session === "object") {
    try {
      await convertGuestSession(userId, guest_session, timezone || "UTC");
    } catch (err) {
      console.error("[signup.guest_session] conversion failed:", err.message);
    }
  }

  return res.status(201).json({
    success: true,
    message: "Signup successful",
    data: result.data,
  });
}

const SESSION_TARGETS = { MORNING: 7, EVENING: 11 };

async function convertGuestSession(userId, guest, userTz) {
  const { session_set_id, kind, local_day_key, brick_ids } = guest;
  if (!session_set_id || !kind || !local_day_key || !Array.isArray(brick_ids)) return;
  if (!SESSION_TARGETS[kind]) return;

  const setRows = await prisma.$queryRawUnsafe(
    `SELECT id, local_day_key, kind FROM daily_session_sets WHERE id = $1::uuid`,
    session_set_id
  );
  if (setRows.length === 0) return;
  const set = setRows[0];
  const setDayIso = toDayKeyString(set.local_day_key);
  if (set.kind !== kind) return;
  if (setDayIso !== local_day_key) return;

  // Window must still be active — drop carry if expired.
  const now = new Date();
  const currentDayIso = toDayKeyString(computeLocalDayKey(now, userTz));
  const currentWindow = resolveSessionWindow(now, userTz);
  if (currentDayIso !== setDayIso) return;
  if (currentWindow !== kind) return;

  // Bootstrap progress row, then insert counted rows (no double count) and
  // recompute partial_count from the row count.
  const target = SESSION_TARGETS[kind];
  await prisma.$queryRawUnsafe(
    `INSERT INTO user_session_progress
       (user_id, session_set_id, partial_count, target_count, created_at, updated_at)
     VALUES ($1, $2::uuid, 0, $3, NOW(), NOW())
     ON CONFLICT (user_id, session_set_id) DO NOTHING`,
    userId, session_set_id, target
  );

  for (const brickId of brick_ids) {
    const member = await prisma.$queryRawUnsafe(
      `SELECT 1 AS hit FROM daily_session_set_items
        WHERE session_set_id = $1::uuid AND brick_id = $2`,
      session_set_id, brickId
    );
    if (member.length === 0) continue;
    await prisma.$queryRawUnsafe(
      `INSERT INTO user_session_brick_counts
         (user_id, session_set_id, brick_id)
       VALUES ($1, $2::uuid, $3)
       ON CONFLICT (user_id, session_set_id, brick_id) DO NOTHING`,
      userId, session_set_id, brickId
    );
  }

  // Recompute partial_count from authoritative row count
  await prisma.$queryRawUnsafe(
    `UPDATE user_session_progress
        SET partial_count = (
          SELECT COUNT(*) FROM user_session_brick_counts
           WHERE user_id = $1 AND session_set_id = $2::uuid
        ),
        updated_at = NOW()
      WHERE user_id = $1 AND session_set_id = $2::uuid`,
    userId, session_set_id
  );
}

async function me(req, res) {
  const user = req.user;
  return res.status(200).json({
    success: true,
    data: {
      id: String(user.id),
      name: user.name,
      email: user.email,
      email_verified_at: user.email_verified_at,
    },
  });
}

module.exports = { login, signup, logout, me };
