import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { Appointment } from '../../src/models/Appointment.js';
import { Payment } from '../../src/models/Payment.js';
import { Customer } from '../../src/models/Customer.js';
import { User } from '../../src/models/User.js';
import { hashPassword } from '../../src/services/authService.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slugA = 'analytics-salon-a';
const slugB = 'analytics-salon-b';

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

describe('GET /analytics/*', () => {
  let tenant;
  let accessToken;
  let seed;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant, accessToken } = await createTenantWithOwner(app, { slug: slugA, displayName: 'Analytics Salon A' }));
    seed = await seedTenantData(tenant._id);
  });

  it('GET /overview counts today, upcoming, cancellations, no-shows, unpaid and sums succeeded revenue', async () => {
    await runWithTenant(tenant._id, async () => {
      const base = { staffMemberId: seed.staff._id, serviceIds: [seed.service._id], customerId: seed.customer._id, priceSnapshot: 350, endTime: daysFromNow(0) };

      const confirmedToday = await Appointment.create({ ...base, startTime: new Date(), status: 'confirmed', paymentStatus: 'unpaid' });
      await Appointment.create({ ...base, startTime: new Date(), status: 'cancelled', cancelledAt: new Date() });
      await Appointment.create({ ...base, startTime: new Date(), status: 'no_show' });
      await Appointment.create({ ...base, startTime: daysFromNow(2), status: 'booked' });

      await Payment.create({ appointmentId: confirmedToday._id, amount: 100, method: 'cash', provider: 'cash', status: 'succeeded' });
      // Must never count toward revenue - not succeeded.
      await Payment.create({ appointmentId: confirmedToday._id, amount: 999, method: 'card', provider: 'yoco', status: 'pending' });
    });

    const res = await request(app).get(`/api/t/${slugA}/analytics/overview`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.bookingsToday).toBe(2); // confirmed + no_show both happened today; the cancelled one is excluded
    expect(res.body.upcomingCount).toBe(1);
    expect(res.body.cancellationsToday).toBe(1);
    expect(res.body.noShowsToday).toBe(1);
    expect(res.body.unpaidCount).toBe(2); // confirmedToday + the future booked one (both default to paymentStatus: 'unpaid')
    expect(res.body.revenueToday).toBe(100);
    // Week/month are supersets of today - deterministic regardless of which
    // day of the week/month the suite happens to run on.
    expect(res.body.revenueWeek).toBeGreaterThanOrEqual(res.body.revenueToday);
    expect(res.body.revenueMonth).toBeGreaterThanOrEqual(res.body.revenueWeek);
  });

  it('GET /unpaid-appointments lists only real unpaid bookings, oldest first, excluding pending_payment/cancelled/no_show', async () => {
    await runWithTenant(tenant._id, async () => {
      const base = { staffMemberId: seed.staff._id, serviceIds: [seed.service._id], customerId: seed.customer._id, priceSnapshot: 350, endTime: daysFromNow(3) };
      await Appointment.create({ ...base, startTime: daysFromNow(3), status: 'confirmed', paymentStatus: 'unpaid' });
      await Appointment.create({ ...base, startTime: daysFromNow(1), status: 'booked', paymentStatus: 'unpaid' });
      await Appointment.create({ ...base, startTime: daysFromNow(2), status: 'pending_payment', paymentStatus: 'unpaid' });
      await Appointment.create({ ...base, startTime: daysFromNow(2), status: 'cancelled', paymentStatus: 'unpaid', cancelledAt: new Date() });
      await Appointment.create({ ...base, startTime: daysFromNow(2), status: 'confirmed', paymentStatus: 'paid_cash' });
    });

    const res = await request(app).get(`/api/t/${slugA}/analytics/unpaid-appointments`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(new Date(res.body[0].startTime).getTime()).toBeLessThan(new Date(res.body[1].startTime).getTime());
    expect(res.body[0].customerId.name).toBe('Alice Client');
  });

  it('GET /summary respects the range window and buckets daily series by day', async () => {
    await runWithTenant(tenant._id, async () => {
      const base = { staffMemberId: seed.staff._id, serviceIds: [seed.service._id], customerId: seed.customer._id, priceSnapshot: 350, endTime: daysAgo(0) };
      const recent = await Appointment.create({ ...base, startTime: daysAgo(2), status: 'completed' });
      const old = await Appointment.create({ ...base, startTime: daysAgo(40), status: 'completed' });

      await Payment.create({ appointmentId: recent._id, amount: 150, method: 'cash', provider: 'cash', status: 'succeeded', createdAt: daysAgo(2) });
      await Payment.create({ appointmentId: old._id, amount: 300, method: 'cash', provider: 'cash', status: 'succeeded', createdAt: daysAgo(40) });
    });

    const narrow = await request(app).get(`/api/t/${slugA}/analytics/summary?range=7d`).set('Authorization', `Bearer ${accessToken}`);
    expect(narrow.status).toBe(200);
    expect(narrow.body.combinedRevenue).toBe(150); // the 40-day-old payment is out of range
    expect(narrow.body.dailyRevenue.some((d) => d.amount === 150)).toBe(true);

    const wide = await request(app).get(`/api/t/${slugA}/analytics/summary?range=90d`).set('Authorization', `Bearer ${accessToken}`);
    expect(wide.status).toBe(200);
    expect(wide.body.combinedRevenue).toBe(450); // both payments now in range
  });

  it('GET /summary computes completion rate from finalized appointments only', async () => {
    await runWithTenant(tenant._id, async () => {
      const base = { staffMemberId: seed.staff._id, serviceIds: [seed.service._id], customerId: seed.customer._id, priceSnapshot: 350, endTime: daysAgo(0) };
      await Appointment.create({ ...base, startTime: daysAgo(1), status: 'completed' });
      await Appointment.create({ ...base, startTime: daysAgo(1), status: 'completed' });
      await Appointment.create({ ...base, startTime: daysAgo(1), status: 'completed' });
      await Appointment.create({ ...base, startTime: daysAgo(1), status: 'cancelled' });
      await Appointment.create({ ...base, startTime: daysFromNow(1), status: 'booked' }); // not finalized - excluded
    });

    const res = await request(app).get(`/api/t/${slugA}/analytics/summary?range=7d`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.completionRate).toBe(75); // 3 completed / 4 finalized
  });

  it('rejects an unrecognized range value', async () => {
    const res = await request(app).get(`/api/t/${slugA}/analytics/summary?range=nonsense`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('a staff-role user can read analytics (no owner-only gate)', async () => {
    const passwordHash = await hashPassword('staff-password-123');
    await runWithTenant(tenant._id, async () => {
      await User.create({ email: 'staff-analytics@example.com', passwordHash, role: 'staff' });
    });
    const loginRes = await request(app).post(`/api/t/${slugA}/auth/login`).send({ email: 'staff-analytics@example.com', password: 'staff-password-123' });

    const res = await request(app).get(`/api/t/${slugA}/analytics/overview`).set('Authorization', `Bearer ${loginRes.body.accessToken}`);
    expect(res.status).toBe(200);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(`/api/t/${slugA}/analytics/overview`);
    expect(res.status).toBe(401);
  });
});

describe('GET /analytics/* tenant isolation', () => {
  it("tenant A's numbers never include tenant B's data", async () => {
    await clearDatabase();
    const { tenant: tenantA, accessToken: tokenA } = await createTenantWithOwner(app, { slug: slugA, displayName: 'Salon A' });
    const { tenant: tenantB } = await createTenantWithOwner(app, { slug: slugB, displayName: 'Salon B' });
    const seedA = await seedTenantData(tenantA._id);
    const seedB = await seedTenantData(tenantB._id);

    await runWithTenant(tenantA._id, async () => {
      const apt = await Appointment.create({
        staffMemberId: seedA.staff._id, serviceIds: [seedA.service._id], customerId: seedA.customer._id,
        priceSnapshot: 350, startTime: new Date(), endTime: new Date(), status: 'confirmed',
      });
      await Payment.create({ appointmentId: apt._id, amount: 100, method: 'cash', provider: 'cash', status: 'succeeded' });
    });
    await runWithTenant(tenantB._id, async () => {
      const apt = await Appointment.create({
        staffMemberId: seedB.staff._id, serviceIds: [seedB.service._id], customerId: seedB.customer._id,
        priceSnapshot: 500, startTime: new Date(), endTime: new Date(), status: 'confirmed',
      });
      await Payment.create({ appointmentId: apt._id, amount: 9999, method: 'cash', provider: 'cash', status: 'succeeded' });
    });

    const res = await request(app).get(`/api/t/${slugA}/analytics/overview`).set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.revenueToday).toBe(100); // never tenant B's 9999
    expect(res.body.bookingsToday).toBe(1);
  });
});

describe('GET /analytics/summary loyalty and client counts', () => {
  it('counts total clients booked in-range and loyalty members as a cumulative snapshot', async () => {
    await clearDatabase();
    const { tenant, accessToken } = await createTenantWithOwner(app, { slug: slugA, displayName: 'Loyalty Salon' });
    const seed = await seedTenantData(tenant._id);

    await runWithTenant(tenant._id, async () => {
      const otherCustomer = await Customer.create({ name: 'Bob Client', phone: '+27821111111', loyaltyPoints: 40 });
      await Customer.updateOne({ _id: seed.customer._id }, { loyaltyPoints: 0 }); // not yet a loyalty member

      const base = { staffMemberId: seed.staff._id, serviceIds: [seed.service._id], priceSnapshot: 350, endTime: daysAgo(0) };
      await Appointment.create({ ...base, customerId: seed.customer._id, startTime: daysAgo(1), status: 'completed' });
      await Appointment.create({ ...base, customerId: otherCustomer._id, startTime: daysAgo(1), status: 'completed' });
      // Cancelled booking's customer should not count toward totalClients.
      const cancelledCustomer = await Customer.create({ name: 'Cancelled Only', phone: '+27822222222' });
      await Appointment.create({ ...base, customerId: cancelledCustomer._id, startTime: daysAgo(1), status: 'cancelled' });
    });

    const res = await request(app).get(`/api/t/${slugA}/analytics/summary?range=7d`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalClients).toBe(2); // Alice + Bob, not the cancelled-only customer
    expect(res.body.loyaltyMembers).toBe(1); // only Bob has loyaltyPoints > 0
  });
});
