import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { pruneOldAuditLogs } from '../../src/lib/auditLog.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearDatabase();
});

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe('pruneOldAuditLogs', () => {
  it('deletes entries older than the default 6-month window and keeps everything newer', async () => {
    // createTenantWithOwner logs the owner in as part of setup, which itself
    // writes one recent 'auth.login_success' entry - accounted for below
    // rather than asserting an exact count that ignores it.
    const { tenant } = await createTenantWithOwner(app, { slug: 'audit-salon', displayName: 'Audit Salon' });

    await runWithTenant(tenant._id, async () => {
      await AuditLog.create({ action: 'appointment.create', entityType: 'Appointment', createdAt: daysAgo(200) });
      await AuditLog.create({ action: 'appointment.create', entityType: 'Appointment', createdAt: daysAgo(179) });
      await AuditLog.create({ action: 'appointment.create', entityType: 'Appointment', createdAt: daysAgo(30) });
    });

    const { deletedCount } = await pruneOldAuditLogs();
    expect(deletedCount).toBe(1);

    const remaining = await runWithTenant(tenant._id, async () => await AuditLog.find({}).sort({ createdAt: 1 }));
    expect(remaining).toHaveLength(3); // the two survivors above + the setup login entry
    expect(remaining.every((entry) => entry.createdAt.getTime() >= daysAgo(180).getTime())).toBe(true);
  });

  it('prunes across every tenant in one call, not just one', async () => {
    const { tenant: tenantA } = await createTenantWithOwner(app, { slug: 'audit-salon-a', displayName: 'Audit Salon A' });
    const { tenant: tenantB } = await createTenantWithOwner(app, { slug: 'audit-salon-b', displayName: 'Audit Salon B' });

    await runWithTenant(tenantA._id, async () => AuditLog.create({ action: 'appointment.create', entityType: 'Appointment', createdAt: daysAgo(300) }));
    await runWithTenant(tenantB._id, async () => AuditLog.create({ action: 'appointment.create', entityType: 'Appointment', createdAt: daysAgo(300) }));

    const { deletedCount } = await pruneOldAuditLogs();
    expect(deletedCount).toBe(2);

    // Each tenant's own setup-login entry is recent and survives the prune.
    const remainingA = await runWithTenant(tenantA._id, async () => await AuditLog.find({}));
    const remainingB = await runWithTenant(tenantB._id, async () => await AuditLog.find({}));
    expect(remainingA).toHaveLength(1);
    expect(remainingB).toHaveLength(1);
  });

  it('respects a custom retentionMonths override', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug: 'audit-salon-custom', displayName: 'Audit Salon Custom' });

    await runWithTenant(tenant._id, () => AuditLog.create({ action: 'auth.login_success', entityType: 'User', createdAt: daysAgo(45) }));

    const { deletedCount } = await pruneOldAuditLogs({ retentionMonths: 1 });
    expect(deletedCount).toBe(1);
  });

  it('is a no-op when there is nothing old enough to prune', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug: 'audit-salon-fresh', displayName: 'Audit Salon Fresh' });
    await runWithTenant(tenant._id, () => AuditLog.create({ action: 'auth.login_success', entityType: 'User' }));

    const { deletedCount } = await pruneOldAuditLogs();
    expect(deletedCount).toBe(0);
  });

  it("still blocks AuditLog.deleteMany() at the Mongoose model level - pruning must go through the raw collection, never loosen this guard", () => {
    expect(() => AuditLog.deleteMany({})).toThrow('AuditLog is append-only');
  });
});
