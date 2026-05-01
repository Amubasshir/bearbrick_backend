const AuthService = require("../services/AuthService");
const prisma = require("../lib/prisma");

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
  const { name, email, password, email_verified } = req.body;
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

  return res.status(201).json({
    success: true,
    message: "Signup successful",
    data: result.data,
  });
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
