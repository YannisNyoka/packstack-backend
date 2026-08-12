import request from 'supertest';
import { provisionTenant } from '../../src/services/platformService.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { Service } from '../../src/models/Service.js';
import { StaffMember } from '../../src/models/StaffMember.js';
import { Customer } from '../../src/models/Customer.js';

export async function createTenantWithOwner(app, { slug, displayName, ownerEmail = 'owner@example.com', ownerPassword = 'correct-horse-battery-staple' }) {
  const tenant = await provisionTenant({ slug, displayName, ownerEmail, ownerPassword });

  const loginRes = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: ownerEmail, password: ownerPassword });
  if (loginRes.status !== 200) {
    throw new Error(`Test setup login failed for ${slug}: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }

  return { tenant, accessToken: loginRes.body.accessToken };
}

/** Creates a Service/StaffMember/Customer directly, bound to the given tenant's context. */
export async function seedTenantData(tenantId) {
  return runWithTenant(tenantId, async () => {
    const service = await Service.create({ name: 'Gel Manicure', durationMinutes: 60, price: 350 });
    const staff = await StaffMember.create({ name: 'Jane Tech', servicesOffered: [service._id] });
    const customer = await Customer.create({ name: 'Alice Client', phone: '+27821234567' });
    return { service, staff, customer };
  });
}
