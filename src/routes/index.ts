import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import activitiesRoutes from '@/modules/activities/activities.routes.js';
import invoicesRoutes, { paymentsRoutes } from '@/modules/invoices/invoices.routes.js';
import quotesRoutes, { publicQuotesRoutes } from '@/modules/quotes/quotes.routes.js';
import campaignsRoutes, { publicCampaignRoutes } from '@/modules/campaigns/campaigns.routes.js';
import subscriptionsRoutes from '@/modules/subscriptions/subscriptions.routes.js';
import { assignmentRulesRoutes, teamsRoutes } from '@/modules/assignment/assignment.routes.js';
import goalsRoutes from '@/modules/goals/goals.routes.js';
import documentsRoutes from '@/modules/documents/documents.routes.js';
import apiKeysRoutes from '@/modules/api-keys/api-keys.routes.js';
import organizationRoutes from '@/modules/organization/organization.routes.js';
import privacyRoutes from '@/modules/privacy/privacy.routes.js';
import ordersRoutes from '@/modules/orders/orders.routes.js';
import productsRoutes, { productCategoriesRoutes } from '@/modules/products/products.routes.js';
import tasksRoutes from '@/modules/tasks/tasks.routes.js';
import authRoutes from '@/modules/auth/auth.routes.js';
import companiesRoutes from '@/modules/companies/companies.routes.js';
import contactsRoutes from '@/modules/contacts/contacts.routes.js';
import customersRoutes from '@/modules/customers/customers.routes.js';
import dashboardRoutes from '@/modules/dashboard/dashboard.routes.js';
import portalRoutes from '@/modules/portal/portal.routes.js';
import leadsRoutes from '@/modules/leads/leads.routes.js';
import rolesRoutes from '@/modules/roles/roles.routes.js';
import ticketsRoutes from '@/modules/support/support.routes.js';
import dealsRoutes from '@/modules/sales/sales.routes.js';
import usersRoutes from '@/modules/users/users.routes.js';
import auditRoutes from '@/modules/audit/audit.routes.js';
import { auditTrail } from '@/middleware/audit-trail.js';
import appointmentsRoutes from '@/modules/appointments/appointments.routes.js';
import portalDocumentsRoutes from '@/modules/portal-documents/portal-documents.routes.js';
import portalNoticesRoutes from '@/modules/portal-notices/portal-notices.routes.js';
import mailRoutes from '@/modules/mail/mail.routes.js';
import recordEmailRoutes from '@/modules/record-emails/record-emails.routes.js';
import webhooksRoutes from '@/modules/webhooks/webhooks.routes.js';
import workflowsRoutes from '@/modules/workflows/workflows.routes.js';
import exportRoutes from '@/modules/exports/exports.routes.js';
import importRoutes from '@/modules/imports/imports.routes.js';
import notificationsRoutes from '@/modules/notifications/notifications.routes.js';
import preferencesRoutes from '@/modules/preferences/preferences.routes.js';
import savedViewsRoutes from '@/modules/saved-views/saved-views.routes.js';
import searchRoutes from '@/modules/search/search.routes.js';
import commentsRoutes from '@/modules/comments/comments.routes.js';
import tagsRoutes from '@/modules/tags/tags.routes.js';
import timelineRoutes from '@/modules/timeline/timeline.routes.js';
import reportsRoutes from '@/modules/reports/reports.routes.js';
import customFieldsRoutes from '@/modules/custom-fields/custom-fields.routes.js';
import emailTemplatesRoutes from '@/modules/mail/email-templates.routes.js';
import inboundEmailRoutes from '@/modules/inbound-email/inbound-email.routes.js';
import docsRoutes from '@/modules/docs/docs.routes.js';

export const routes = Router();

// Liveness: the process is up. Readiness: it can actually reach the database.
routes.get('/health', (_req, res) => {
  res.json({ success: true, message: 'ok', data: { status: 'up' } });
});

routes.get('/health/ready', async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    res.json({ success: true, message: 'ok', data: { status: 'ready' } });
  } catch {
    res.status(503).json({ success: false, message: 'Not ready', code: 'NOT_READY', errors: [] });
  }
});

// Records successful staff mutations; must run before every router so it can observe their responses.
routes.use(auditTrail);

// Export/import routers define full paths (/leads/export, /exports/:id, ...) and must come before the resource routers so they win over /:id.
routes.use(mailRoutes);
routes.use(recordEmailRoutes);
routes.use(exportRoutes);
routes.use(importRoutes);

routes.use('/auth', authRoutes);
routes.use('/contacts', contactsRoutes);
routes.use('/companies', companiesRoutes);
routes.use('/leads', leadsRoutes);
routes.use('/deals', dealsRoutes);
routes.use('/dashboard', dashboardRoutes);
routes.use('/invoices', invoicesRoutes);
routes.use('/payments', paymentsRoutes);
routes.use('/orders', ordersRoutes);
routes.use('/quotes', quotesRoutes);
routes.use('/public/quotes', publicQuotesRoutes);
routes.use('/campaigns', campaignsRoutes);
routes.use('/subscriptions', subscriptionsRoutes);
routes.use('/teams', teamsRoutes);
routes.use('/goals', goalsRoutes);
routes.use('/documents', documentsRoutes);
routes.use('/api-keys', apiKeysRoutes);
routes.use('/organization', organizationRoutes);
routes.use('/privacy', privacyRoutes);
routes.use('/assignment-rules', assignmentRulesRoutes);
routes.use('/public', publicCampaignRoutes);
routes.use('/products', productsRoutes);
routes.use('/product-categories', productCategoriesRoutes);
routes.use('/tasks', tasksRoutes);
routes.use('/activities', activitiesRoutes);
routes.use('/tickets', ticketsRoutes);
routes.use('/customers', customersRoutes);
routes.use('/portal', portalRoutes);
routes.use('/users', usersRoutes);
routes.use('/roles', rolesRoutes);
routes.use('/notifications', notificationsRoutes);
routes.use('/me/preferences', preferencesRoutes);
routes.use('/saved-views', savedViewsRoutes);
routes.use('/audit-logs', auditRoutes);
routes.use('/webhooks', webhooksRoutes);
routes.use('/workflows', workflowsRoutes);
routes.use('/portal-notices', portalNoticesRoutes);
routes.use('/portal-documents', portalDocumentsRoutes);
routes.use('/appointments', appointmentsRoutes);
routes.use('/search', searchRoutes);
routes.use('/comments', commentsRoutes);
routes.use('/tags', tagsRoutes);
routes.use('/timeline', timelineRoutes);
routes.use('/reports', reportsRoutes);
routes.use('/custom-fields', customFieldsRoutes);
routes.use('/email-templates', emailTemplatesRoutes);
routes.use('/inbound', inboundEmailRoutes);
routes.use('/docs', docsRoutes);
