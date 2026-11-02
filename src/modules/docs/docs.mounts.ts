import type { Router } from 'express';
import activitiesRoutes from '@/modules/activities/activities.routes.js';
import appointmentsRoutes from '@/modules/appointments/appointments.routes.js';
import auditRoutes from '@/modules/audit/audit.routes.js';
import authRoutes from '@/modules/auth/auth.routes.js';
import companiesRoutes from '@/modules/companies/companies.routes.js';
import contactsRoutes from '@/modules/contacts/contacts.routes.js';
import customersRoutes from '@/modules/customers/customers.routes.js';
import dashboardRoutes from '@/modules/dashboard/dashboard.routes.js';
import exportRoutes from '@/modules/exports/exports.routes.js';
import importRoutes from '@/modules/imports/imports.routes.js';
import invoicesRoutes, { paymentsRoutes } from '@/modules/invoices/invoices.routes.js';
import leadsRoutes from '@/modules/leads/leads.routes.js';
import mailRoutes from '@/modules/mail/mail.routes.js';
import recordEmailRoutes from '@/modules/record-emails/record-emails.routes.js';
import notificationsRoutes from '@/modules/notifications/notifications.routes.js';
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
import portalDocumentsRoutes from '@/modules/portal-documents/portal-documents.routes.js';
import portalNoticesRoutes from '@/modules/portal-notices/portal-notices.routes.js';
import portalRoutes from '@/modules/portal/portal.routes.js';
import preferencesRoutes from '@/modules/preferences/preferences.routes.js';
import productsRoutes, { productCategoriesRoutes } from '@/modules/products/products.routes.js';
import rolesRoutes from '@/modules/roles/roles.routes.js';
import dealsRoutes from '@/modules/sales/sales.routes.js';
import savedViewsRoutes from '@/modules/saved-views/saved-views.routes.js';
import ticketsRoutes from '@/modules/support/support.routes.js';
import tasksRoutes from '@/modules/tasks/tasks.routes.js';
import usersRoutes from '@/modules/users/users.routes.js';
import webhooksRoutes from '@/modules/webhooks/webhooks.routes.js';
import workflowsRoutes from '@/modules/workflows/workflows.routes.js';
import searchRoutes from '@/modules/search/search.routes.js';
import commentsRoutes from '@/modules/comments/comments.routes.js';
import tagsRoutes from '@/modules/tags/tags.routes.js';
import timelineRoutes from '@/modules/timeline/timeline.routes.js';
import reportsRoutes from '@/modules/reports/reports.routes.js';
import customFieldsRoutes from '@/modules/custom-fields/custom-fields.routes.js';
import emailTemplatesRoutes from '@/modules/mail/email-templates.routes.js';
import inboundEmailRoutes from '@/modules/inbound-email/inbound-email.routes.js';

export interface Mount {
  path: string;
  router: Router;
}

// Mirrors src/routes/index.ts (docs.mounts.test.ts fails when they drift). Path '' = router defines full paths itself.
export const mounts: Mount[] = [
  { path: '', router: mailRoutes },
  { path: '', router: recordEmailRoutes },
  { path: '', router: exportRoutes },
  { path: '', router: importRoutes },
  { path: '/auth', router: authRoutes },
  { path: '/contacts', router: contactsRoutes },
  { path: '/companies', router: companiesRoutes },
  { path: '/leads', router: leadsRoutes },
  { path: '/deals', router: dealsRoutes },
  { path: '/dashboard', router: dashboardRoutes },
  { path: '/invoices', router: invoicesRoutes },
  { path: '/payments', router: paymentsRoutes },
  { path: '/orders', router: ordersRoutes },
  { path: '/quotes', router: quotesRoutes },
  { path: '/public/quotes', router: publicQuotesRoutes },
  { path: '/campaigns', router: campaignsRoutes },
  { path: '/subscriptions', router: subscriptionsRoutes },
  { path: '/teams', router: teamsRoutes },
  { path: '/goals', router: goalsRoutes },
  { path: '/documents', router: documentsRoutes },
  { path: '/api-keys', router: apiKeysRoutes },
  { path: '/organization', router: organizationRoutes },
  { path: '/privacy', router: privacyRoutes },
  { path: '/assignment-rules', router: assignmentRulesRoutes },
  { path: '/public', router: publicCampaignRoutes },
  { path: '/products', router: productsRoutes },
  { path: '/product-categories', router: productCategoriesRoutes },
  { path: '/tasks', router: tasksRoutes },
  { path: '/activities', router: activitiesRoutes },
  { path: '/tickets', router: ticketsRoutes },
  { path: '/customers', router: customersRoutes },
  { path: '/portal', router: portalRoutes },
  { path: '/users', router: usersRoutes },
  { path: '/roles', router: rolesRoutes },
  { path: '/notifications', router: notificationsRoutes },
  { path: '/me/preferences', router: preferencesRoutes },
  { path: '/saved-views', router: savedViewsRoutes },
  { path: '/audit-logs', router: auditRoutes },
  { path: '/webhooks', router: webhooksRoutes },
  { path: '/workflows', router: workflowsRoutes },
  { path: '/portal-notices', router: portalNoticesRoutes },
  { path: '/portal-documents', router: portalDocumentsRoutes },
  { path: '/appointments', router: appointmentsRoutes },
  { path: '/search', router: searchRoutes },
  { path: '/comments', router: commentsRoutes },
  { path: '/tags', router: tagsRoutes },
  { path: '/timeline', router: timelineRoutes },
  { path: '/reports', router: reportsRoutes },
  { path: '/custom-fields', router: customFieldsRoutes },
  { path: '/email-templates', router: emailTemplatesRoutes },
  { path: '/inbound', router: inboundEmailRoutes },
];
