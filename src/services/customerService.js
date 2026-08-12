import { Customer } from '../models/Customer.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';

export async function listCustomers({ search } = {}) {
  const filter = search
    ? { $or: [{ name: new RegExp(escapeRegex(search), 'i') }, { phone: new RegExp(escapeRegex(search)) }] }
    : {};
  return Customer.find(filter).sort({ name: 1 }).limit(200);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getCustomerById(id) {
  const customer = await Customer.findById(id);
  if (!customer) throw ApiError.notFound('Customer not found');
  return customer;
}

export async function createCustomer({ req, actorUserId, data }) {
  const customer = await Customer.create(data);
  await logAudit({ req, actorUserId, action: 'customer.create', entityType: 'Customer', entityId: customer._id, diff: { after: data } });
  return customer;
}

export async function updateCustomer({ req, actorUserId, id, data }) {
  const customer = await getCustomerById(id);
  const before = customer.toObject();
  Object.assign(customer, data);
  await customer.save();
  await logAudit({ req, actorUserId, action: 'customer.update', entityType: 'Customer', entityId: id, diff: { before, after: data } });
  return customer;
}

/**
 * Used by the public booking flow: finds an existing customer by phone or
 * creates one, without requiring a logged-in staff user (no actorUserId).
 */
export async function findOrCreateByPhone({ phone, name, email }) {
  let customer = await Customer.findOne({ phone });
  if (!customer) {
    customer = await Customer.create({ phone, name, email: email || null });
  }
  return customer;
}
