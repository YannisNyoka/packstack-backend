import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { jest } from '@jest/globals';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { Appointment } from '../../src/models/Appointment.js';
import { Payment } from '../../src/models/Payment.js';
import { releaseStalePendingPayments } from '../../src/services/depositService.js';

let app;
let fetchSpy;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

afterEach(() => {
  fetchSpy?.mockRestore();
});

const slug = 'deposit-salon';
const futureStart = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const WEBHOOK_SECRET = 'whsec_c2VjcmV0a2V5Zm9ydGVzdGluZzEyMzQ=';

function signWebhook({ webhookId, webhookTimestamp, rawBody }) {
  const keyBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', keyBytes).update(`${webhookId}.${webhookTimestamp}.${rawBody}`).digest('base64');
  return `v1,${sig}`;
}

async function connectYoco(accessToken) {
  return request(app)
    .post(`/api/t/${slug}/integrations/yoco`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ secretKey: 'sk_test_abc123', webhookSecret: WEBHOOK_SECRET });
}

async function requireDeposit(accessToken, amountZAR = 100) {
  return request(app)
    .patch(`/api/t/${slug}/settings/booking-rules`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ depositRequired: true, depositAmountZAR: amountZAR });
}

describe('deposit checkout flow', () => {
  let tenant;
  let accessToken;
  let seed;

  beforeEach(async () => {
    await clearDatabase();
    const created = await createTenantWithOwner(app, { slug, displayName: 'Deposit Salon' });
    tenant = created.tenant;
    accessToken = created.accessToken;
    seed = await seedTenantData(tenant._id);
  });

  describe('GET /public/deposit-config', () => {
    it('reports not required when the toggle is off', async () => {
      const res = await request(app).get(`/api/t/${slug}/public/deposit-config`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ required: false, amountZAR: 0 });
    });

    it('reports not required when the toggle is on but Yoco is not connected', async () => {
      await requireDeposit(accessToken);
      const res = await request(app).get(`/api/t/${slug}/public/deposit-config`);
      expect(res.body).toEqual({ required: false, amountZAR: 0 });
    });

    it('reports required once both the toggle is on and Yoco is connected', async () => {
      await connectYoco(accessToken);
      await requireDeposit(accessToken, 150);
      const res = await request(app).get(`/api/t/${slug}/public/deposit-config`);
      expect(res.body).toEqual({ required: true, amountZAR: 150 });
    });
  });

  describe('POST /public/appointments/checkout', () => {
    it('rejects when a deposit is not required', async () => {
      const res = await request(app)
        .post(`/api/t/${slug}/public/appointments/checkout`)
        .send({
          staffMemberId: String(seed.staff._id),
          serviceIds: [String(seed.service._id)],
          startTime: futureStart(),
          customerDetails: { phone: '+27821112222', name: 'Deposit Client' },
        });
      expect(res.status).toBe(400);
    });

    it('holds the slot, creates a pending Payment, and returns the Yoco checkout URL', async () => {
      await connectYoco(accessToken);
      await requireDeposit(accessToken, 100);

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'ch_test123', redirectUrl: 'https://pay.yoco.com/ch_test123', status: 'created' }),
      });

      const startTime = futureStart();
      const res = await request(app)
        .post(`/api/t/${slug}/public/appointments/checkout`)
        .send({
          staffMemberId: String(seed.staff._id),
          serviceIds: [String(seed.service._id)],
          startTime,
          customerDetails: { phone: '+27821112222', name: 'Deposit Client' },
        });

      expect(res.status).toBe(201);
      expect(res.body.checkoutUrl).toBe('https://pay.yoco.com/ch_test123');

      const [fetchUrl, fetchOpts] = fetchSpy.mock.calls[0];
      expect(fetchUrl).toBe('https://payments.yoco.com/api/checkouts');
      expect(fetchOpts.headers.Authorization).toBe('Bearer sk_test_abc123');
      const sentBody = JSON.parse(fetchOpts.body);
      expect(sentBody.amount).toBe(10000); // R100 in cents
      expect(sentBody.currency).toBe('ZAR');

      const appointment = await runWithTenant(tenant._id, async () => Appointment.findById(res.body.appointmentId));
      expect(appointment.status).toBe('pending_payment');

      const payment = await runWithTenant(tenant._id, async () => Payment.findOne({ appointmentId: appointment._id }));
      expect(payment.status).toBe('pending');
      expect(payment.provider).toBe('yoco');
      expect(payment.providerTransactionId).toBe('ch_test123');
      expect(payment.amount).toBe(100);

      // The held slot should no longer show up as available.
      const availRes = await request(app)
        .get(`/api/t/${slug}/public/availability`)
        .query({ date: startTime.slice(0, 10), serviceIds: String(seed.service._id), staffMemberId: String(seed.staff._id) });
      expect(availRes.body.staff[0].slots.some((s) => s === startTime || new Date(s).getTime() === new Date(startTime).getTime())).toBe(false);
    });

    it('releases the held slot if Yoco checkout creation fails', async () => {
      await connectYoco(accessToken);
      await requireDeposit(accessToken, 100);

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ message: 'invalid request' }),
      });

      const res = await request(app)
        .post(`/api/t/${slug}/public/appointments/checkout`)
        .send({
          staffMemberId: String(seed.staff._id),
          serviceIds: [String(seed.service._id)],
          startTime: futureStart(),
          customerDetails: { phone: '+27821112222', name: 'Deposit Client' },
        });
      expect(res.status).toBe(400);

      const appointments = await runWithTenant(tenant._id, async () => Appointment.find({}));
      expect(appointments).toHaveLength(1);
      expect(appointments[0].status).toBe('cancelled');
    });
  });

  describe('POST /public/deposit-webhook', () => {
    async function createPendingCheckout() {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'ch_webhook_test', redirectUrl: 'https://pay.yoco.com/ch_webhook_test', status: 'created' }),
      });
      const res = await request(app)
        .post(`/api/t/${slug}/public/appointments/checkout`)
        .send({
          staffMemberId: String(seed.staff._id),
          serviceIds: [String(seed.service._id)],
          startTime: futureStart(),
          customerDetails: { phone: '+27821112222', name: 'Deposit Client' },
        });
      fetchSpy.mockRestore();
      return res.body.appointmentId;
    }

    it('confirms the appointment and marks the payment succeeded on a valid payment.succeeded webhook', async () => {
      await connectYoco(accessToken);
      await requireDeposit(accessToken, 100);
      const appointmentId = await createPendingCheckout();

      const rawBody = JSON.stringify({
        id: 'evt_1',
        type: 'payment.succeeded',
        createdDate: new Date().toISOString(),
        payload: { id: 'p_1', status: 'succeeded', metadata: { checkoutId: 'ch_webhook_test' } },
      });
      const webhookId = 'msg_1';
      const webhookTimestamp = String(Math.floor(Date.now() / 1000));

      const res = await request(app)
        .post(`/api/t/${slug}/public/deposit-webhook`)
        .set('webhook-id', webhookId)
        .set('webhook-timestamp', webhookTimestamp)
        .set('webhook-signature', signWebhook({ webhookId, webhookTimestamp, rawBody }))
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(200);

      const appointment = await runWithTenant(tenant._id, async () => Appointment.findById(appointmentId));
      expect(appointment.status).toBe('booked');

      const payment = await runWithTenant(tenant._id, async () => Payment.findOne({ appointmentId }));
      expect(payment.status).toBe('succeeded');
    });

    it('rejects a webhook with an invalid signature and leaves the appointment pending', async () => {
      await connectYoco(accessToken);
      await requireDeposit(accessToken, 100);
      const appointmentId = await createPendingCheckout();

      const rawBody = JSON.stringify({
        type: 'payment.succeeded',
        payload: { metadata: { checkoutId: 'ch_webhook_test' } },
      });
      const webhookId = 'msg_2';
      const webhookTimestamp = String(Math.floor(Date.now() / 1000));

      const res = await request(app)
        .post(`/api/t/${slug}/public/deposit-webhook`)
        .set('webhook-id', webhookId)
        .set('webhook-timestamp', webhookTimestamp)
        .set('webhook-signature', 'v1,dGhpc2lzbm90dmFsaWQ=')
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(403);

      const appointment = await runWithTenant(tenant._id, async () => Appointment.findById(appointmentId));
      expect(appointment.status).toBe('pending_payment');
    });

    it('is idempotent when the same webhook arrives twice', async () => {
      await connectYoco(accessToken);
      await requireDeposit(accessToken, 100);
      const appointmentId = await createPendingCheckout();

      const rawBody = JSON.stringify({
        type: 'payment.succeeded',
        payload: { metadata: { checkoutId: 'ch_webhook_test' } },
      });
      const webhookId = 'msg_3';
      const webhookTimestamp = String(Math.floor(Date.now() / 1000));
      const signatureHeader = signWebhook({ webhookId, webhookTimestamp, rawBody });

      for (let i = 0; i < 2; i++) {
        const res = await request(app)
          .post(`/api/t/${slug}/public/deposit-webhook`)
          .set('webhook-id', webhookId)
          .set('webhook-timestamp', webhookTimestamp)
          .set('webhook-signature', signatureHeader)
          .set('Content-Type', 'application/json')
          .send(rawBody);
        expect(res.status).toBe(200);
      }

      const appointment = await runWithTenant(tenant._id, async () => Appointment.findById(appointmentId));
      expect(appointment.status).toBe('booked');
    });
  });

  describe('releaseStalePendingPayments sweep', () => {
    it('cancels a pending_payment appointment older than the timeout and marks its payment failed', async () => {
      await connectYoco(accessToken);
      await requireDeposit(accessToken, 100);

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'ch_stale', redirectUrl: 'https://pay.yoco.com/ch_stale', status: 'created' }),
      });
      const checkoutRes = await request(app)
        .post(`/api/t/${slug}/public/appointments/checkout`)
        .send({
          staffMemberId: String(seed.staff._id),
          serviceIds: [String(seed.service._id)],
          startTime: futureStart(),
          customerDetails: { phone: '+27821112222', name: 'Stale Client' },
        });

      await runWithTenant(tenant._id, async () => {
        // Mongoose's timestamps:true strips createdAt from a normal updateOne
        // (by design - it's meant to be creation-only) - go through the raw
        // driver collection to backdate it for this test.
        await Appointment.collection.updateOne(
          { _id: new mongoose.Types.ObjectId(checkoutRes.body.appointmentId) },
          { $set: { createdAt: new Date(Date.now() - 60 * 60_000) } }
        );
      });

      const result = await releaseStalePendingPayments();
      expect(result.releasedCount).toBe(1);

      const appointment = await runWithTenant(tenant._id, async () => Appointment.findById(checkoutRes.body.appointmentId));
      expect(appointment.status).toBe('cancelled');

      const payment = await runWithTenant(tenant._id, async () => Payment.findOne({ appointmentId: appointment._id }));
      expect(payment.status).toBe('failed');
    });

    it('leaves a fresh pending_payment appointment alone', async () => {
      await connectYoco(accessToken);
      await requireDeposit(accessToken, 100);

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'ch_fresh', redirectUrl: 'https://pay.yoco.com/ch_fresh', status: 'created' }),
      });
      const checkoutRes = await request(app)
        .post(`/api/t/${slug}/public/appointments/checkout`)
        .send({
          staffMemberId: String(seed.staff._id),
          serviceIds: [String(seed.service._id)],
          startTime: futureStart(),
          customerDetails: { phone: '+27821112222', name: 'Fresh Client' },
        });

      const result = await releaseStalePendingPayments();
      expect(result.releasedCount).toBe(0);

      const appointment = await runWithTenant(tenant._id, async () => Appointment.findById(checkoutRes.body.appointmentId));
      expect(appointment.status).toBe('pending_payment');
    });
  });
});
