import { ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { assertRelatedExists, relatedTypes, viewPermission, type RelatedType } from './activities.related.js';
import { activitiesRepository } from './activities.repository.js';
import type { ActivityListQuery, CreateActivityInput, UpdateActivityInput } from './activities.validation.js';

type Actor = { permissions: readonly string[] };

const canView = ({ permissions }: Actor, type: RelatedType) => permissions.includes(viewPermission[type]);

function assertCanView(actor: Actor, type: string) {
  const known = relatedTypes.find((t) => t === type);
  if (!known || !canView(actor, known)) throw new ForbiddenError();
}

class ActivitiesService {
  private async assertCanViewActivity(organizationId: string, id: string, actor: Actor) {
    const type = await activitiesRepository.findRelatedType({ organizationId, id });
    if (!type) throw new NotFoundError('Activity not found');
    assertCanView(actor, type);
  }

  // Only activity on records the caller may view.
  async listRecentActivities({ organizationId, limit, actor }: { organizationId: string; limit: number; actor: Actor }) {
    return activitiesRepository.listRecent({ organizationId, limit, types: relatedTypes.filter((t) => canView(actor, t)) });
  }

  async listActivitiesFor({ organizationId, query, actor }: { organizationId: string; query: ActivityListQuery; actor: Actor }) {
    assertCanView(actor, query.relatedType);
    return activitiesRepository.listForRecord({ organizationId, ...query });
  }

  async createActivity({ organizationId, userId, input, actor }: { organizationId: string; userId: string; input: CreateActivityInput; actor: Actor }) {
    assertCanView(actor, input.relatedType);
    const { occurredAt, ...rest } = input;
    await assertRelatedExists(organizationId, rest.relatedType, rest.relatedId);
    return activitiesRepository.create({ organizationId, userId, input: { ...rest, ...(occurredAt && { occurredAt: new Date(occurredAt) }) } });
  }

  async updateActivity({ organizationId, id, input, actor }: { organizationId: string; id: string; input: UpdateActivityInput; actor: Actor }) {
    await this.assertCanViewActivity(organizationId, id, actor);
    const { occurredAt, ...rest } = input;
    const activity = await activitiesRepository.update({ organizationId, id, changes: { ...rest, ...(occurredAt && { occurredAt: new Date(occurredAt) }) } });
    if (!activity) throw new NotFoundError('Activity not found');
    return activity;
  }

  async deleteActivity({ organizationId, id, actor }: { organizationId: string; id: string; actor: Actor }) {
    await this.assertCanViewActivity(organizationId, id, actor);
    if (!(await activitiesRepository.delete({ organizationId, id }))) throw new NotFoundError('Activity not found');
  }
}

export const activitiesService = new ActivitiesService();
