import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { env } from './config/env.js';
import { corsOptions } from './config/cors.js';
import tenantRouter from './routes/tenantRouter.js';
import platformRoutes from './routes/platformRoutes.js';
import publicDomainRoutes from './routes/publicDomainRoutes.js';
import publicPlansRoutes from './routes/publicPlansRoutes.js';
import publicSignupRoutes from './routes/publicSignupRoutes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render sits behind a proxy - needed for req.ip / rate limiting to see the real client IP

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(
    express.json({
      limit: '1mb',
      // Captures the exact raw bytes of every JSON request body - cheap, and
      // needed by routes/publicRoutes.js's Yoco webhook handler to verify
      // Yoco's HMAC signature, which is computed over the raw bytes as sent,
      // not a parsed-then-reserialized copy (same reasoning as the PayFast
      // ITN route's own raw-body capture in platformBillingRoutes.js).
      verify: (req, res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test') {
    app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  }

  app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

  app.use('/api/platform', platformRoutes);
  app.use('/api/public/domains', publicDomainRoutes);
  app.use('/api/public/plans', publicPlansRoutes);
  app.use('/api/public/signup', publicSignupRoutes);
  app.use('/api/t/:tenantSlug', tenantRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
