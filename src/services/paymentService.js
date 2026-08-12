import { Payment } from '../models/Payment.js';
import { Appointment } from '../models/Appointment.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';

const METHOD_TO_APPOINTMENT_STATUS = {
  cash: 'paid_cash',
  card: 'paid_card',
  online: 'paid_online',
};

export async function recordPayment({ req, actorUserId, appointmentId, amount, method, provider, providerTransactionId }) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw ApiError.notFound('Appointment not found');

  const payment = await Payment.create({
    appointmentId,
    amount,
    method,
    provider,
    providerTransactionId: providerTransactionId || null,
    status: 'succeeded',
    recordedByUserId: actorUserId,
  });

  const previousPaymentStatus = appointment.paymentStatus;
  appointment.paymentStatus = METHOD_TO_APPOINTMENT_STATUS[method];
  await appointment.save();

  await logAudit({
    req,
    actorUserId,
    action: 'payment.status_change',
    entityType: 'Appointment',
    entityId: appointmentId,
    diff: { before: { paymentStatus: previousPaymentStatus }, after: { paymentStatus: appointment.paymentStatus, paymentId: payment._id } },
  });

  return { payment, appointment };
}

export async function listPaymentsForAppointment(appointmentId) {
  return Payment.find({ appointmentId }).sort({ createdAt: -1 });
}
