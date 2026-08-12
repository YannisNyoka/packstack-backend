import { ThemeConfig } from '../models/ThemeConfig.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';

export async function getTheme() {
  const theme = await ThemeConfig.findOne({});
  if (!theme) throw ApiError.notFound('Theme not configured');
  return theme;
}

export async function updateTheme({ req, actorUserId, data }) {
  const theme = await ThemeConfig.findOne({});
  if (!theme) throw ApiError.notFound('Theme not configured');

  const before = theme.toObject();

  const { colors, contactInfo, socialLinks, ...flat } = data;
  Object.assign(theme, flat);
  if (colors) Object.assign(theme.colors, colors);
  if (contactInfo) Object.assign(theme.contactInfo, contactInfo);
  if (socialLinks) Object.assign(theme.socialLinks, socialLinks);

  await theme.save();

  await logAudit({
    req,
    actorUserId,
    action: 'tenant.theme_update',
    entityType: 'ThemeConfig',
    entityId: theme._id,
    diff: { before, after: theme.toObject() },
  });

  return theme;
}
