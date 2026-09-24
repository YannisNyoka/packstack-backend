import request from 'supertest';
import { DateTime } from 'luxon';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { Service } from '../../src/models/Service.js';
import { StaffMember } from '../../src/models/StaffMember.js';
import { Appointment } from '../../src/models/Appointment.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

// Exercises the TOCTOU gap between appointmentService.js's assertNoConflict()
// pre-check and the actual write: two requests for the exact same
// staff+start racing each other can both pass the pre-check (both findOne
// calls can resolve clean before either create() commits), so only the
// Appointment model's unique partial index (see Appointment.js) actually
// closes the gap - the loser's write throws a Mongo duplicate-key error,
// which createAppointment/rescheduleAppointment must turn into the same
// friendly SLOT_CONFLICT response the pre-check itself returns.
describe('Double-booking race protection', () => {
  const slug = 'double-booking-salon';
  let tenant;
  let service;
  let staff;
  let startTime;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant } = await createTenantWithOwner(app, { slug, displayName: 'Double Booking Salon', allowAnonymousBooking: true }));

    const future = DateTime.now().setZone(tenant.timezone).plus({ days: 14 }).startOf('day');
    const weekdayKey = future.toFormat('ccc').toLowerCase();

    await runWithTenant(tenant._id, async () => {
      service = await Service.create({ name: 'Manicure', durationMinutes: 30, price: 200 });
      staff = await StaffMember.create({
        name: 'Solo Staff',
        servicesOffered: [service._id],
        workingHours: { [weekdayKey]: [{ start: '09:00', end: '17:00' }] },
      });
    });

    startTime = future.set({ hour: 10 }).toISO();
  });

  it('lets only one of two simultaneous bookings for the same staff+slot win, the other gets a clean 409', async () => {
    const bookingPayload = (name) => ({
      staffMemberId: String(staff._id),
      serviceIds: [String(service._id)],
      startTime,
      customerDetails: { phone: `082${name}`, name: `Racer ${name}` },
    });

    const [resA, resB] = await Promise.all([
      request(app).post(`/api/t/${slug}/public/appointments`).send(bookingPayload('0000001')),
      request(app).post(`/api/t/${slug}/public/appointments`).send(bookingPayload('0000002')),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const conflictRes = resA.status === 409 ? resA : resB;
    expect(conflictRes.body.error.code).toBe('SLOT_CONFLICT');

    const appointments = await runWithTenant(tenant._id, async () => Appointment.find({ staffMemberId: staff._id }));
    expect(appointments).toHaveLength(1);
  });

  it('rejects a reschedule into a slot another appointment already holds', async () => {
    const otherStart = DateTime.fromISO(startTime).plus({ hours: 2 }).toISO();

    const first = await request(app).post(`/api/t/${slug}/public/appointments`).send({
      staffMemberId: String(staff._id),
      serviceIds: [String(service._id)],
      startTime,
      customerDetails: { phone: '0821110001', name: 'First' },
    });
    expect(first.status).toBe(201);

    const second = await request(app).post(`/api/t/${slug}/public/appointments`).send({
      staffMemberId: String(staff._id),
      serviceIds: [String(service._id)],
      startTime: otherStart,
      customerDetails: { phone: '0821110002', name: 'Second' },
    });
    expect(second.status).toBe(201);

    // Reschedule the second appointment directly onto the first one's exact
    // start time (via the service layer directly - no dashboard auth setup
    // needed for what this test is about). This alone only exercises the
    // pre-check (assertNoConflict), same as before this change - real
    // reschedule-vs-reschedule concurrency would need the same Promise.all
    // race as the create test above to reach rescheduleAppointment's own
    // duplicate-key catch, but there was no coverage at all for a plain
    // sequential reschedule conflict either, so this closes that gap too.
    const rescheduleRes = await runWithTenant(tenant._id, async () => {
      const { rescheduleAppointment } = await import('../../src/services/appointmentService.js');
      try {
        await rescheduleAppointment({
          tenantId: tenant._id,
          id: second.body._id,
          newStartTime: startTime,
          enforceBookingRules: false,
        });
        return { conflicted: false };
      } catch (err) {
        return { conflicted: true, code: err.code };
      }
    });

    expect(rescheduleRes.conflicted).toBe(true);
    expect(rescheduleRes.code).toBe('SLOT_CONFLICT');
  });
});
