import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { User } from '../../src/models/User.js';
import { hashPassword } from '../../src/services/authService.js';
import * as domainService from '../../src/services/domainService.js';
import { corsOptions } from '../../src/config/cors.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slugA = 'domains-salon-a';
const slugB = 'domains-salon-b';

function corsCheck(origin) {
  return new Promise((resolve) => {
    corsOptions.origin(origin, (err, allowed) => resolve({ err, allowed }));
  });
}

// domainService calls logAudit() internally, which writes a tenant-scoped
// AuditLog entry - fine when called from an HTTP route (already running
// inside tenantResolution()'s bound context), but calling the service
// directly in a test needs the same binding, same as any other direct
// service-layer test in this suite (see tenantIsolation.test.js's note on
// the `async () => await ...` shape).
async function addDomainAs(tenantId, domain) {
  return runWithTenant(tenantId, async () => await domainService.addDomain({ req: {}, actorUserId: null, tenantId, domain }));
}

async function verifyDomainAs(tenantId, domain, resolveTxt) {
  return runWithTenant(tenantId, async () => await domainService.verifyDomain({ req: {}, actorUserId: null, tenantId, domain, resolveTxt }));
}

describe('Custom domains (Phase 3)', () => {
  let tenantA;
  let tenantB;
  let ownerTokenA;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant: tenantA, accessToken: ownerTokenA } = await createTenantWithOwner(app, { slug: slugA, displayName: 'Domains Salon A' }));
    ({ tenant: tenantB } = await createTenantWithOwner(app, { slug: slugB, displayName: 'Domains Salon B' }));
  });

  describe('POST /domains', () => {
    it('adds a domain and returns TXT verification instructions', async () => {
      const res = await request(app)
        .post(`/api/t/${slugA}/domains`)
        .set('Authorization', `Bearer ${ownerTokenA}`)
        .send({ domain: 'booking.salon-a.example' });

      expect(res.status).toBe(201);
      expect(res.body.verified).toBe(false);
      expect(res.body.dnsInstructions).toEqual({
        type: 'TXT',
        host: '_packstack-verify.booking.salon-a.example',
        value: expect.any(String),
      });
    });

    it('rejects a malformed domain', async () => {
      const res = await request(app).post(`/api/t/${slugA}/domains`).set('Authorization', `Bearer ${ownerTokenA}`).send({ domain: 'not a domain' });
      expect(res.status).toBe(400);
    });

    it('rejects a domain already claimed by another tenant', async () => {
      await addDomainAs(tenantB._id, 'shared.example');

      const res = await request(app)
        .post(`/api/t/${slugA}/domains`)
        .set('Authorization', `Bearer ${ownerTokenA}`)
        .send({ domain: 'shared.example' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DOMAIN_TAKEN');
    });

    it('rejects staff from adding a domain', async () => {
      const passwordHash = await hashPassword('staff-password-123');
      await runWithTenant(tenantA._id, async () => {
        await User.create({ email: 'staff@example.com', passwordHash, role: 'staff' });
      });
      const loginRes = await request(app).post(`/api/t/${slugA}/auth/login`).send({ email: 'staff@example.com', password: 'staff-password-123' });

      const res = await request(app)
        .post(`/api/t/${slugA}/domains`)
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
        .send({ domain: 'staff-attempt.example' });
      expect(res.status).toBe(403);
    });
  });

  describe('verifyDomain (DNS TXT check)', () => {
    it('verifies when the TXT record matches the issued token', async () => {
      const { dnsInstructions } = await addDomainAs(tenantA._id, 'verify-me.example');
      const resolveTxt = async (host) => {
        expect(host).toBe(dnsInstructions.host);
        return [[dnsInstructions.value]];
      };

      const mapping = await verifyDomainAs(tenantA._id, 'verify-me.example', resolveTxt);
      expect(mapping.verified).toBe(true);
    });

    it('handles a TXT value split across multiple string chunks', async () => {
      const { dnsInstructions } = await addDomainAs(tenantA._id, 'split-chunks.example');
      const half = Math.floor(dnsInstructions.value.length / 2);
      const resolveTxt = async () => [[dnsInstructions.value.slice(0, half), dnsInstructions.value.slice(half)]];

      const mapping = await verifyDomainAs(tenantA._id, 'split-chunks.example', resolveTxt);
      expect(mapping.verified).toBe(true);
    });

    it('rejects when the TXT record does not match', async () => {
      await addDomainAs(tenantA._id, 'wrong-token.example');
      const resolveTxt = async () => [['some-other-value']];

      await expect(verifyDomainAs(tenantA._id, 'wrong-token.example', resolveTxt)).rejects.toMatchObject({
        statusCode: 400,
        code: 'DOMAIN_NOT_VERIFIED',
      });
    });

    it('rejects when the DNS lookup fails entirely (no record, NXDOMAIN, etc.)', async () => {
      await addDomainAs(tenantA._id, 'no-record.example');
      const resolveTxt = async () => {
        throw new Error('ENOTFOUND');
      };

      await expect(verifyDomainAs(tenantA._id, 'no-record.example', resolveTxt)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('is idempotent for an already-verified domain (no DNS lookup needed)', async () => {
      const { dnsInstructions } = await addDomainAs(tenantA._id, 'already-verified.example');
      await verifyDomainAs(tenantA._id, 'already-verified.example', async () => [[dnsInstructions.value]]);

      const res = await request(app).post(`/api/t/${slugA}/domains/already-verified.example/verify`).set('Authorization', `Bearer ${ownerTokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
    });
  });

  describe('tenant isolation', () => {
    it("does not list another tenant's domains", async () => {
      await addDomainAs(tenantB._id, 'only-b.example');
      await addDomainAs(tenantA._id, 'only-a.example');

      const res = await request(app).get(`/api/t/${slugA}/domains`).set('Authorization', `Bearer ${ownerTokenA}`);
      expect(res.status).toBe(200);
      const domains = res.body.map((d) => d.domain);
      expect(domains).toContain('only-a.example');
      expect(domains).not.toContain('only-b.example');
    });

    it('404s deleting a domain that belongs to a different tenant', async () => {
      await addDomainAs(tenantB._id, 'belongs-to-b.example');

      const res = await request(app).delete(`/api/t/${slugA}/domains/belongs-to-b.example`).set('Authorization', `Bearer ${ownerTokenA}`);
      expect(res.status).toBe(404);

      const stillThere = await domainService.listDomains(tenantB._id);
      expect(stillThere.some((d) => d.domain === 'belongs-to-b.example')).toBe(true);
    });
  });

  describe('GET /api/public/domains/:domain (frontend bootstrap resolution)', () => {
    it('resolves a verified domain to its tenant slug', async () => {
      const { dnsInstructions } = await addDomainAs(tenantA._id, 'live.example');
      await verifyDomainAs(tenantA._id, 'live.example', async () => [[dnsInstructions.value]]);

      const res = await request(app).get('/api/public/domains/live.example');
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(slugA);
    });

    it('404s for an unverified domain', async () => {
      await addDomainAs(tenantA._id, 'pending.example');
      const res = await request(app).get('/api/public/domains/pending.example');
      expect(res.status).toBe(404);
    });

    it('404s for a domain nobody has added', async () => {
      const res = await request(app).get('/api/public/domains/nobody-added-this.example');
      expect(res.status).toBe(404);
    });
  });

  describe('CORS accepts verified custom domains', () => {
    it('allows an Origin whose domain is verified', async () => {
      const { dnsInstructions } = await addDomainAs(tenantA._id, 'cors-verified.example');
      await verifyDomainAs(tenantA._id, 'cors-verified.example', async () => [[dnsInstructions.value]]);

      const { err, allowed } = await corsCheck('https://cors-verified.example');
      expect(err).toBeNull();
      expect(allowed).toBe(true);
    });

    it('rejects an Origin whose domain was never verified', async () => {
      await addDomainAs(tenantA._id, 'cors-unverified.example');

      const { err } = await corsCheck('https://cors-unverified.example');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
