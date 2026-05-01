const prisma = require("../lib/prisma");
const crypto = require("crypto");

async function store(req, res) {
  const brick_id =
    req.body.brick_id != null ? String(req.body.brick_id).trim() : "";
  const vote_type = req.body.vote_type;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!brick_id || !vote_type) {
    return res.status(422).json({
      success: false,
      message: "Validation error",
      errors: {
        brick_id: brick_id ? [] : ["Required"],
        vote_type: vote_type ? [] : ["Required"],
      },
    });
  }
  if (!UUID_RE.test(brick_id)) {
    return res.status(422).json({
      success: false,
      message: "Validation error",
      errors: { brick_id: ["Must be a valid UUID"] },
    });
  }
  if (!["UNDER", "FAIR", "OVER"].includes(vote_type)) {
    return res.status(422).json({
      success: false,
      message: "Validation error",
      errors: { vote_type: ["Must be UNDER, FAIR, or OVER"] },
    });
  }

  const user = req.user;
  const ipHash = crypto
    .createHash("sha256")
    .update(req.ip || "127.0.0.1")
    .digest("hex");
  const userAgent = req.get("user-agent") || null;
  const sessionId = req.sessionID || null;

  const intent = await prisma.voteIntent.create({
    data: {
      userId: user.id,
      brickId: brick_id,
      voteType: vote_type,
      ipHash,
      userAgent,
      sessionId,
      status: "PENDING",
    },
  });

  res.status(201).json({
    success: true,
    message: "Vote intent accepted",
    data: { status: "ACCEPTED", intent_id: Number(intent.id) },
  });
}

module.exports = { store };
