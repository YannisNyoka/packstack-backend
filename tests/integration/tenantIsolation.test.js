import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { Service } from '../../src/models/Service.js';
import { Appointment } from '../../src/models/Appointment.js';
import { TenantScopeViolationError } from '../../src/plugins/tenantScopePlugin.js';

let app;
let tenantA;
let tenantB;
let seedA;
let seedB;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearDatabase();

  tenantA = await createTenantWithOwner(app, { slug: 'salon-a', displayName: 'Salon A', ownerEmail: 'owner-a@example.com' });
  tenantB = await createTenantWithOwner(app, { slug: 'salon-b', displayName: 'Salon B', ownerEmail: 'owner-b@example.com' });

  seedA = await seedTenantData(tenantA.tenant._id);
  seedB = await seedTenantData(tenantB.tenant._id);
});

describe('HTTP layer: tenant token vs URL mismatch', () => {
  it('rejects tenant B token used against tenant A URL, before touching any data', async () => {
    const res = await request(app)
      .get('/api/t/salon-a/services')
      .set('Authorization', `Bearer ${tenantB.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });

  it('rejects tenant A token used against tenant B URL', async () => {
    const res = await request(app)
      .get('/api/t/salon-b/customers')
      .set('Authorization', `Bearer ${tenantA.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });
});

describe('HTTP layer: list endpoints never leak across tenants', () => {
  it('tenant A only sees its own services', async () => {
    const res = await request(app).get('/api/t/salon-a/services').set('Authorization', `Bearer ${tenantA.accessToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((s) => s._id);
    expect(ids).toContain(String(seedA.service._id));
    expect(ids).not.toContain(String(seedB.service._id));
  });

  it('tenant B only sees its own customers', async () => {
    const res = await request(app).get('/api/t/salon-b/customers').set('Authorization', `Bearer ${tenantB.accessToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((c) => c._id);
    expect(ids).toContain(String(seedB.customer._id));
    expect(ids).not.toContain(String(seedA.customer._id));
  });
});

describe('HTTP layer: IDOR - fetching another tenant\'s record by ID', () => {
  it('returns 404, not the record, when tenant B requests tenant A\'s service ID under its own (valid) token+URL', async () => {
    const res = await request(app)
      .get(`/api/t/salon-b/services/${seedA.service._id}`)
      .set('Authorization', `Bearer ${tenantB.accessToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 404 for another tenant\'s customer ID', async () => {
    const res = await request(app)
      .get(`/api/t/salon-b/customers/${seedA.customer._id}`)
      .set('Authorization', `Bearer ${tenantB.accessToken}`);

    expect(res.status).toBe(404);
  });

  it('cannot cancel another tenant\'s appointment', async () => {
    const appointment = await runWithTenant(tenantA.tenant._id, () =>
      Appointment.create({
        customerId: seedA.customer._id,
        staffMemberId: seedA.staff._id,
        serviceIds: [seedA.service._id],
        startTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        endTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000),
        priceSnapshot: 350,
      })
    );

    const res = await request(app)
      .patch(`/api/t/salon-b/appointments/${appointment._id}/cancel`)
      .set('Authorization', `Bearer ${tenantB.accessToken}`)
      .send({ reason: 'trying to mess with another tenant' });

    expect(res.status).toBe(404);

    const stillBooked = await runWithTenant(tenantA.tenant._id, async () => await Appointment.findById(appointment._id));
    expect(stillBooked.status).toBe('booked');
  });
});

describe('ODM layer: tenantScopePlugin enforcement (defense in depth)', () => {
  it('refuses to run a tenant-scoped query with no tenant context bound', async () => {
    await expect(Service.find({})).rejects.toThrow(/No tenant context/);
  });

  // Note the `async () => await ...` shape throughout this block, not
  // `() => Model.find(...)`: Mongoose queries are lazy (calling .find()/
  // .findById() just builds a Query - it doesn't execute until .exec()/
  // .then() is called). If the callback passed to runWithTenant() isn't
  // itself async and doesn't await the query, the query is only actually
  // *executed* later, outside runWithTenant()'s callback frame, by which
  // point the AsyncLocalStorage context has already unwound - so the very
  // check these tests exist to prove would spuriously fail with "no tenant
  // context" instead of the isolation behavior being tested. Model.create()
  // and Model.aggregate() don't have this trap (they execute eagerly), which
  // is why they don't need the same treatment.

  it('scopes findById so a document from another tenant is invisible even queried directly', async () => {
    const found = await runWithTenant(tenantB.tenant._id, async () => await Service.findById(seedA.service._id));
    expect(found).toBeNull();
  });

  it('throws if a query filter explicitly targets a different tenant than the bound context', async () => {
    await expect(
      runWithTenant(tenantB.tenant._id, async () => await Service.find({ tenantId: tenantA.tenant._id }))
    ).rejects.toThrow(TenantScopeViolationError);
  });

  it('rejects an update payload that attempts to change tenantId to a different tenant', async () => {
    await expect(
      runWithTenant(
        tenantA.tenant._id,
        async () => await Service.updateOne({ _id: seedA.service._id }, { tenantId: tenantB.tenant._id, name: 'Renamed' })
      )
    ).rejects.toThrow(TenantScopeViolationError);

    // The whole update is rejected, not partially applied - "name" was not changed either.
    const reread = await runWithTenant(tenantA.tenant._id, async () => await Service.findById(seedA.service._id));
    expect(String(reread.tenantId)).toBe(String(tenantA.tenant._id));
    expect(reread.name).toBe(seedA.service.name);
  });

  it('allows a normal update that does not touch tenantId', async () => {
    await runWithTenant(tenantA.tenant._id, async () => await Service.updateOne({ _id: seedA.service._id }, { name: 'Renamed' }));

    const reread = await runWithTenant(tenantA.tenant._id, async () => await Service.findById(seedA.service._id));
    expect(String(reread.tenantId)).toBe(String(tenantA.tenant._id));
    expect(reread.name).toBe('Renamed');
  });

  it('auto-assigns tenantId on create without the caller specifying it', async () => {
    const created = await runWithTenant(tenantA.tenant._id, async () => await Service.create({ name: 'Pedicure', durationMinutes: 45, price: 300 }));
    expect(String(created.tenantId)).toBe(String(tenantA.tenant._id));
  });

  it('scopes aggregate() pipelines to the current tenant', async () => {
    const resultsAsB = await runWithTenant(tenantB.tenant._id, async () => await Service.aggregate([{ $match: {} }]));
    expect(resultsAsB.map((s) => String(s._id))).not.toContain(String(seedA.service._id));
  });
});
