import { withTransaction } from '@/config/database.js';
import { isUniqueViolation } from '@/database/soft-delete.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { customFieldsRepository } from './custom-fields.repository.js';
import { entityTypes, validateCustomFields } from './custom-fields.validate.js';
import type { EntityType } from './custom-fields.validate.js';
import { MAX_ACTIVE_DEFINITIONS } from './custom-fields.validation.js';
import type { CreateDefinitionInput, UpdateDefinitionInput } from './custom-fields.validation.js';

const limitError = () => new ConflictError(`At most ${MAX_ACTIVE_DEFINITIONS} active custom fields per entity type`, 'CUSTOM_FIELD_LIMIT');

class CustomFieldsService {
  list({ organizationId, entityType, activeOnly }: { organizationId: string; entityType: EntityType; activeOnly: boolean }) {
    return customFieldsRepository.list({ organizationId, entityType, activeOnly });
  }

  // For lead/contact/deal services. Create: always validated (required fields apply). Update: undefined input means "leave as is".
  async resolve({
    organizationId,
    entityType,
    input,
    partial,
  }: {
    organizationId: string;
    entityType: EntityType;
    input: Record<string, unknown> | undefined;
    partial: boolean;
  }) {
    if (partial && input === undefined) return undefined;
    const definitions = await customFieldsRepository.list({ organizationId, entityType, activeOnly: true });
    return validateCustomFields(definitions, input, { partial });
  }

  // cf[key]=value filters may only use keys of active definitions.
  async assertFilterKeys({ organizationId, entityType, cf }: { organizationId: string; entityType: EntityType; cf: Record<string, string> | undefined }) {
    const keys = Object.keys(cf ?? {});
    if (!keys.length) return;
    const known = new Set((await customFieldsRepository.list({ organizationId, entityType, activeOnly: true })).map((d) => d.key));
    const unknown = keys.filter((k) => !known.has(k));
    if (unknown.length) throw new BadRequestError(`Unknown custom field filter: ${unknown.join(', ')}`, 'INVALID_CUSTOM_FIELD_FILTER');
  }

  create({ organizationId, input }: { organizationId: string; input: CreateDefinitionInput }) {
    return withTransaction(async (tx) => {
      if ((await customFieldsRepository.countActive({ organizationId, entityType: input.entityType }, tx)) >= MAX_ACTIVE_DEFINITIONS) throw limitError();
      const position = input.position ?? (await customFieldsRepository.nextPosition({ organizationId, entityType: input.entityType }, tx));
      return customFieldsRepository.create({ organizationId, input, position }, tx).catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw new ConflictError('A custom field with this key already exists (deactivated fields keep their key)', 'DUPLICATE_CUSTOM_FIELD');
        throw error;
      });
    });
  }

  update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateDefinitionInput }) {
    return withTransaction(async (tx) => {
      const existing = await customFieldsRepository.findById({ organizationId, id }, tx);
      if (!existing) throw new NotFoundError('Custom field not found');
      const entityType = entityTypes.find((t) => t === existing.entityType);
      if (!entityType) throw new NotFoundError('Custom field not found');
      if (input.options && existing.type !== 'select') throw new BadRequestError('Only select fields have options', 'INVALID_OPTIONS');
      if (
        input.isActive &&
        !existing.isActive &&
        (await customFieldsRepository.countActive({ organizationId, entityType: entityType }, tx)) >= MAX_ACTIVE_DEFINITIONS
      ) {
        throw limitError();
      }
      const row = await customFieldsRepository.update({ organizationId, id, input }, tx);
      if (!row) throw new NotFoundError('Custom field not found');
      return row;
    });
  }

  // Soft delete: values already stored in records stay but are ignored.
  async remove({ organizationId, id }: { organizationId: string; id: string }) {
    if (!(await customFieldsRepository.update({ organizationId, id, input: { isActive: false } }))) throw new NotFoundError('Custom field not found');
  }
}

export const customFieldsService = new CustomFieldsService();
