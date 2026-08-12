import mongoose from 'mongoose';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { clearTenantCache } from '../../src/lib/tenantCache.js';

export async function connectTestDB() {
  await mongoose.connect(env.MONGODB_URI);
}

export async function disconnectTestDB() {
  await mongoose.disconnect();
}

export async function clearDatabase() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
  // Tests reuse the same slugs across cases after wiping the DB - without
  // this, the in-memory tenant cache (real, and correct, in production)
  // would keep resolving a slug to a tenant _id from the previous test that
  // no longer exists.
  clearTenantCache();
}

export function buildTestApp() {
  return createApp();
}
