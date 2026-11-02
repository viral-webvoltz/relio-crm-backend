import { withTransaction } from '@/config/database.js';
import { ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { savedViewsRepository } from './saved-views.repository.js';
import type { CreateViewInput, UpdateViewInput } from './saved-views.validation.js';

const MAX_VIEWS_PER_RESOURCE = 50;

type Actor = { organizationId: string; userId: string };

class SavedViewsService {
  async list({ organizationId, userId, resource }: Actor & { resource: string }) {
    const rows = await savedViewsRepository.list({ organizationId, userId, resource });
    return rows.map((r) => ({ ...r, isOwner: r.ownerId === userId }));
  }

  create({ organizationId, userId, input }: Actor & { input: CreateViewInput }) {
    return withTransaction(async (tx) => {
      await savedViewsRepository.lockOwner({ userId }, tx);
      const owned = await savedViewsRepository.countOwned({ organizationId, userId, resource: input.resource }, tx);
      if (owned >= MAX_VIEWS_PER_RESOURCE) throw new ConflictError('Saved view limit reached', 'SAVED_VIEW_LIMIT');
      const row = await savedViewsRepository.create({ organizationId, userId, input }, tx);
      return { ...row, isOwner: true };
    });
  }

  // 404 when the view is not visible to the caller, 403 when it is visible (shared) but not theirs.
  private async assertOwner({ organizationId, userId, id }: Actor & { id: string }) {
    const view = await savedViewsRepository.findVisible({ organizationId, userId, id });
    if (!view) throw new NotFoundError('Saved view not found');
    if (view.ownerId !== userId) throw new ForbiddenError('Only the owner can change this view', 'FORBIDDEN');
  }

  async update({ organizationId, userId, id, input }: Actor & { id: string; input: UpdateViewInput }) {
    await this.assertOwner({ organizationId, userId, id });
    const row = await savedViewsRepository.update({ organizationId, id, input });
    if (!row) throw new NotFoundError('Saved view not found');
    return { ...row, isOwner: true };
  }

  async remove({ organizationId, userId, id }: Actor & { id: string }) {
    await this.assertOwner({ organizationId, userId, id });
    if (!(await savedViewsRepository.remove({ organizationId, id }))) throw new NotFoundError('Saved view not found');
  }
}

export const savedViewsService = new SavedViewsService();
