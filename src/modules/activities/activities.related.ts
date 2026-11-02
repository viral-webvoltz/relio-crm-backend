import type { DbExecutor } from '@/config/database.js';
import type { PermissionKey } from '@/shared/constants/permissions.js';
import { BadRequestError } from '@/shared/errors/index.js';
import { activitiesRepository } from './activities.repository.js';

export const relatedTypes = ['lead', 'deal', 'contact', 'company'] as const;
export type RelatedType = (typeof relatedTypes)[number];

// An activity is part of its record's history, so it is only visible to someone who may view that record.
export const viewPermission: Record<RelatedType, PermissionKey> = {
  lead: 'leads.view',
  deal: 'deals.view',
  contact: 'contacts.view',
  company: 'companies.view',
};

// Tasks and activities point at records of several kinds without a foreign key, so check the target here.
export async function assertRelatedExists(organizationId: string, type: RelatedType, id: string, executor?: DbExecutor) {
  if (!(await activitiesRepository.relatedExists({ organizationId, type, id }, executor))) {
    throw new BadRequestError(`The linked ${type} does not exist`, 'INVALID_RELATED');
  }
}

// With no foreign key to cascade, deleting a record must remove its tasks and activity itself.
// ponytail: two sequential deletes after the record is gone; pass one transaction executor if partial cleanup ever matters.
export async function removeRelatedRecords(organizationId: string, type: RelatedType, id: string, executor?: DbExecutor) {
  await activitiesRepository.deleteTasksFor({ organizationId, type, id }, executor);
  await activitiesRepository.deleteForRecord({ organizationId, type, id }, executor);
}
