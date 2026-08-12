import request from 'supertest';
import { DateTime } from 'luxon';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { Service } from '../../src/models/Service.js';
import { StaffMember } from '../../src/models/StaffMember.js';
import { Appointment } from '../../src/models/Appointment.js';
import { Customer } from '../../src/models/Customer.js';
import { StaffTimeOff } from '../../src/models/StaffTimeOff.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('GET /public/availability', () => {
  const slug = 'availability-salon';
  let tenant;
  let service;
  let staffWithService;
  let staffWithoutService;
  let futureDate;
  let weekdayKey;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant } = await createTenantWithOwner(app, { slug, displayName: 'Availability Salon' }));

    // 14 days out sidesteps the same-day cutoff and "past date" edge cases,
    // which get their own dedicated tests below.
    const future = DateTime.now().setZone(tenant.timezone).plus({ days: 14 }).startOf('day');
    futureDate = future.toISODate();
    weekdayKey = future.toFormat('ccc').toLowerCase();

    await runWithTenant(tenant._id, async () => {
      service = await Service.create({ name: 'Manicure', durationMinutes: 30, price: 200 });
      staffWithService = await StaffMember.create({
        name: 'Staff With Service',
        servicesOffered: [service._id],
        workingHours: { [weekdayKey]: [{ start: '09:00', end: '11:00' }] },
      });
      staffWithoutService = await StaffMember.create({
        name: 'Staff Without Service',
        servicesOffered: [],
        workingHours: { [weekdayKey]: [{ start: '09:00', end: '11:00' }] },
      });
    });
  });

  it('returns 15-minute-stepped slots within working hours for staff offering the service', async () => {
    const res = await request(app)
      .get(`/api/t/${slug}/public/availability`)
      .query({ date: futureDate, serviceIds: String(service._id) });

    expect(res.status).toBe(200);
    expect(res.body.staff).toHaveLength(1);
    const [result] = res.body.staff;
    expect(result.staffMemberId).toBe(String(staffWithService._id));
    // 09:00-11:00 window, 30min service, last valid start is 10:30 -> 7 slots on a 15min grid.
    expect(result.slots).toHaveLength(7);
    expect(result.slots[0]).toContain('09:00');
    expect(result.slots.at(-1)).toContain('10:30');
  });

  it('excludes staff who do not offer the requested service', async () => {
    const res = await request(app)
      .get(`/api/t/${slug}/public/availability`)
      .query({ date: futureDate, serviceIds: String(service._id) });

    const ids = res.body.staff.map((s) => s.staffMemberId);
    expect(ids).not.toContain(String(staffWithoutService._id));
  });

  it('excludes slots that would overlap an existing appointment', async () => {
    const bookedStart = DateTime.fromISO(futureDate, { zone: tenant.timezone }).set({ hour: 9, minute: 30 });
    await runWithTenant(tenant._id, async () => {
      const customer = await Customer.create({ name: 'Existing Client', phone: '+27821111111' });
      await Appointment.create({
        customerId: customer._id,
        staffMemberId: staffWithService._id,
        serviceIds: [service._id],
        startTime: bookedStart.toJSDate(),
        endTime: bookedStart.plus({ minutes: 30 }).toJSDate(),
        priceSnapshot: 200,
      });
    });

    const res = await request(app)
      .get(`/api/t/${slug}/public/availability`)
      .query({ date: futureDate, serviceIds: String(service._id) });

    const [result] = res.body.staff;
    // 09:15 -> [09:15,09:45) and 09:30 -> [09:30,10:00) both overlap the booked [09:30,10:00) slot.
    expect(result.slots.some((s) => s.includes('T09:15'))).toBe(false);
    expect(result.slots.some((s) => s.includes('T09:30'))).toBe(false);
    // 09:00 -> [09:00,09:30) does not overlap.
    expect(result.slots.some((s) => s.includes('T09:00'))).toBe(true);
  });

  it('returns no slots for a date in the past', async () => {
    const pastDate = DateTime.now().setZone(tenant.timezone).minus({ days: 1 }).toISODate();
    const res = await request(app)
      .get(`/api/t/${slug}/public/availability`)
      .query({ date: pastDate, serviceIds: String(service._id) });

    expect(res.status).toBe(200);
    expect(res.body.staff).toEqual([]);
  });

  it('rejects a request missing serviceIds', async () => {
    const res = await request(app).get(`/api/t/${slug}/public/availability`).query({ date: futureDate });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed date', async () => {
    const res = await request(app)
      .get(`/api/t/${slug}/public/availability`)
      .query({ date: '14-08-2026', serviceIds: String(service._id) });
    expect(res.status).toBe(400);
  });

  it('excludes a staff member entirely on a whole-day time-off entry', async () => {
    await runWithTenant(tenant._id, async () => {
      await StaffTimeOff.create({ staffMemberId: staffWithService._id, date: futureDate, reason: 'Sick day' });
    });

    const res = await request(app)
      .get(`/api/t/${slug}/public/availability`)
      .query({ date: futureDate, serviceIds: String(service._id) });

    expect(res.status).toBe(200);
    expect(res.body.staff).toHaveLength(1);
    expect(res.body.staff[0].slots).toEqual([]);
  });

  it('excludes only the overlapping slots for a partial-day time-off entry', async () => {
    await runWithTenant(tenant._id, async () => {
      await StaffTimeOff.create({
        staffMemberId: staffWithService._id,
        date: futureDate,
        startTime: '09:30',
        endTime: '10:00',
        reason: 'Personal appointment',
      });
    });

    const res = await request(app)
      .get(`/api/t/${slug}/public/availability`)
      .query({ date: futureDate, serviceIds: String(service._id) });

    const [result] = res.body.staff;
    // 09:15 -> [09:15,09:45) and 09:30 -> [09:30,10:00) both overlap the blocked [09:30,10:00) window.
    expect(result.slots.some((s) => s.includes('T09:15'))).toBe(false);
    expect(result.slots.some((s) => s.includes('T09:30'))).toBe(false);
    // 09:00 -> [09:00,09:30) does not overlap.
    expect(result.slots.some((s) => s.includes('T09:00'))).toBe(true);
  });

  it('scopes to a single staff member when staffMemberId is given', async () => {
    const res = await request(app).get(`/api/t/${slug}/public/availability`).query({
      date: futureDate,
      serviceIds: String(service._id),
      staffMemberId: String(staffWithService._id),
    });

    expect(res.status).toBe(200);
    expect(res.body.staff).toHaveLength(1);
    expect(res.body.staff[0].staffMemberId).toBe(String(staffWithService._id));
  });
});
