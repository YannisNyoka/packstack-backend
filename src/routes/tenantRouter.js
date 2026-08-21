import { Router } from 'express';
import { tenantResolution } from '../middleware/tenantResolution.js';
import { enforceTenantStatus } from '../middleware/enforceTenantStatus.js';
import authRoutes from './authRoutes.js';
import publicRoutes from './publicRoutes.js';
import serviceRoutes from './serviceRoutes.js';
import staffRoutes from './staffRoutes.js';
import customerRoutes from './customerRoutes.js';
import appointmentRoutes from './appointmentRoutes.js';
import integrationRoutes from './integrationRoutes.js';
import subscriptionRoutes from './subscriptionRoutes.js';
import domainRoutes from './domainRoutes.js';
import tenantSettingsRoutes from './tenantSettingsRoutes.js';
import customerAccountAuthRoutes from './customerAccountAuthRoutes.js';
import customerAccountRoutes from './customerAccountRoutes.js';

const router = Router({ mergeParams: true });

// Everything under here runs inside the resolved tenant's AsyncLocalStorage
// context (see middleware/tenantResolution.js) - this is the one place that
// binding happens for the whole tenant-scoped API surface.
router.use(tenantResolution());
router.use(enforceTenantStatus());

router.use('/auth', authRoutes);
router.use('/public', publicRoutes);
router.use('/services', serviceRoutes);
router.use('/staff', staffRoutes);
router.use('/customers', customerRoutes);
// Must be mounted before '/account' below (and never nested under
// '/customers', which applies requireAuth() - staff-only - to its entire
// subtree) - Express matches these by registration order, and
// customerAccountRoutes applies requireCustomerAuth() to its whole router,
// which would otherwise swallow signup/login requests too.
router.use('/account/auth', customerAccountAuthRoutes);
router.use('/account', customerAccountRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/integrations', integrationRoutes);
router.use('/billing', subscriptionRoutes);
router.use('/domains', domainRoutes);
router.use('/settings', tenantSettingsRoutes);

export default router;
