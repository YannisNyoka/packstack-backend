import mongoose from 'mongoose';

const { Schema } = mongoose;

// Platform-level accounts (you). Deliberately NOT tenant-scoped and
// deliberately a separate model/collection from User, with its own login
// endpoint and JWT secret (JWT_SUPERADMIN_SECRET) - see middleware/auth.js.
// This means there is no shared code path where a bug in tenant-user auth
// could be mistaken for a superadmin credential.
const superAdminUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const SuperAdminUser = mongoose.models.SuperAdminUser || mongoose.model('SuperAdminUser', superAdminUserSchema);
