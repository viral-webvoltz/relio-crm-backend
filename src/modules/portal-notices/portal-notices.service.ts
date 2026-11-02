import { NotFoundError } from '@/shared/errors/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { portalNoticesRepository } from './portal-notices.repository.js';
import type { CreateNoticeInput, UpdateNoticeInput } from './portal-notices.validation.js';

class PortalNoticesService {
  list(organizationId: string, query: ListQuery) {
    return portalNoticesRepository.list(organizationId, query);
  }

  async create({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateNoticeInput }) {
    const row = await portalNoticesRepository.insert({
      organizationId,
      createdBy: userId,
      ...input,
      publishedAt: input.isPublished ? new Date() : null,
    });
    if (!row) throw new Error('Notice insert returned no row');
    return row;
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateNoticeInput }) {
    const current = await portalNoticesRepository.find(organizationId, id);
    if (!current) throw new NotFoundError('Notice not found');
    // The first publish stamps the publish time; later edits and unpublish/republish keep it.
    const publishedAt = input.isPublished && !current.publishedAt ? new Date() : undefined;
    const row = await portalNoticesRepository.update(organizationId, id, { ...input, publishedAt });
    if (!row) throw new NotFoundError('Notice not found');
    return row;
  }

  async remove(organizationId: string, id: string) {
    if (!(await portalNoticesRepository.delete(organizationId, id))) throw new NotFoundError('Notice not found');
  }
}

export const portalNoticesService = new PortalNoticesService();
