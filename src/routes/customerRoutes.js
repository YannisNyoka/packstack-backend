import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as customerService from '../services/customerService.js';
import loyaltyRoutes from './loyaltyRoutes.js';

const router = Router({ mergeParams: true });

router.use(requireAuth());

const customerInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(5).max(20),
  email: z.string().email().optional().nullable(),
  notes: z.string().max(5000).optional().default(''),
});

const customerUpdateSchema = customerInputSchema.partial();

router.get('/', async (req, res, next) => {
  try {
    res.json(await customerService.listCustomers({ search: req.query.search }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await customerService.getCustomerById(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(customerInputSchema), async (req, res, next) => {
  try {
    const customer = await customerService.createCustomer({ req, actorUserId: req.auth.userId, data: req.body });
    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', validate(customerUpdateSchema), async (req, res, next) => {
  try {
    const customer = await customerService.updateCustomer({
      req,
      actorUserId: req.auth.userId,
      id: req.params.id,
      data: req.body,
    });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

router.use('/:customerId/loyalty', loyaltyRoutes);

export default router;
