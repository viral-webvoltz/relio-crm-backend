import { withTransaction } from '@/config/database.js';
import { isUniqueViolation } from '@/database/soft-delete.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { tagsRepository } from './tags.repository.js';
import type { CreateTagInput, TagContactsQuery, UpdateTagInput } from './tags.validation.js';

const duplicate = () => new ConflictError('A tag with this name already exists', 'TAG_NAME_TAKEN');

class TagsService {
  list(organizationId: string) {
    return tagsRepository.listWithCounts(organizationId);
  }

  async create({ organizationId, input }: { organizationId: string; input: CreateTagInput }) {
    if (await tagsRepository.findByName({ organizationId, name: input.name })) throw duplicate();
    try {
      const row = await tagsRepository.insert({ organizationId, ...input });
      if (!row) throw new Error('Tag insert returned no row');
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicate();
      throw err;
    }
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateTagInput }) {
    const existing = await tagsRepository.findById({ organizationId, id });
    if (!existing) throw new NotFoundError('Tag not found');
    if (input.name) {
      const clash = await tagsRepository.findByName({ organizationId, name: input.name });
      if (clash && clash.id !== id) throw duplicate();
    }
    try {
      const row = await tagsRepository.update({ organizationId, id, changes: input });
      return row ?? existing;
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicate();
      throw err;
    }
  }

  async remove({ organizationId, id }: { organizationId: string; id: string }) {
    if (!(await tagsRepository.remove({ organizationId, id }))) throw new NotFoundError('Tag not found');
  }

  async setContactTags({ organizationId, contactId, tagIds }: { organizationId: string; contactId: string; tagIds: string[] }) {
    const ids = [...new Set(tagIds)];
    return withTransaction(async (tx) => {
      if (!(await tagsRepository.contactExists({ organizationId, contactId }, tx))) throw new NotFoundError('Contact not found');
      if ((await tagsRepository.countExisting({ organizationId, ids }, tx)) !== ids.length)
        throw new BadRequestError('One or more tags do not exist', 'INVALID_TAGS');
      await tagsRepository.replaceContactTags({ organizationId, contactId, tagIds: ids }, tx);
      return tagsRepository.listForContact({ organizationId, contactId }, tx);
    });
  }

  async forContact({ organizationId, contactId }: { organizationId: string; contactId: string }) {
    if (!(await tagsRepository.contactExists({ organizationId, contactId }))) throw new NotFoundError('Contact not found');
    return tagsRepository.listForContact({ organizationId, contactId });
  }

  async contactsOf({ organizationId, id, query }: { organizationId: string; id: string; query: TagContactsQuery }) {
    if (!(await tagsRepository.findById({ organizationId, id }))) throw new NotFoundError('Tag not found');
    return tagsRepository.listContacts({ organizationId, tagId: id, query });
  }
}

export const tagsService = new TagsService();
