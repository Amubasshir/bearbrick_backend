const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

async function login(email, password) {
  // Trim and lowercase email for consistent lookup
  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    return { success: false, message: "Invalid credentials" };
  }

  // Verify password
  const passwordMatch = await bcrypt.compare(password, user.password);
  if (!passwordMatch) {
    return { success: false, message: "Invalid credentials" };
  }
  const token = jwt.sign({ sub: String(user.id) }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
  return {
    success: true,
    message: "Login successful",
    data: {
      user: {
        id: String(user.id),
        name: user.name,
        email: user.email,
        email_verified_at: user.email_verified_at,
      },
      token,
      token_type: "Bearer",
    },
  };
}

async function signup(name, email, password, emailVerified = false) {
  // Check if email already exists
  const existingUser = await prisma.user.findUnique({
    where: { email },
  });
  if (existingUser) {
    return { success: false, message: "Email already registered" };
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Create user with identity state + an opening bounty balance row, atomically
  // (M4 D3 / Q12 — every new user gets exactly one user_balances row on signup).
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        email_verified_at: emailVerified ? new Date() : null,
        identityState: {
          create: {
            emailVerified: emailVerified,
            trustTier: 0,
            behaviorState: "NORMAL",
          },
        },
      },
    });
    await tx.$executeRawUnsafe(
      `INSERT INTO user_balances (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      created.id
    );
    return created;
  });

  // Generate token
  const token = jwt.sign({ sub: String(user.id) }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

  return {
    success: true,
    message: "Signup successful",
    data: {
      user: {
        id: String(user.id),
        name: user.name,
        email: user.email,
        email_verified_at: user.email_verified_at,
      },
      token,
      token_type: "Bearer",
    },
  };
}

module.exports = { login, signup };
