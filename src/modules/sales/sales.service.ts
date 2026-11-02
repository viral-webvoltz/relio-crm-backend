import { notify } from '@/modules/notifications/notifier.js';
import { withTransaction } from '@/config/database.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { isUniqueViolation } from '@/database/soft-delete.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { customFieldsService } from '@/modules/custom-fields/custom-fields.service.js';
import { salesRepository } from './sales.repository.js';
import type { CreateDealInput, DealListQuery, MoveDealInput, UpdateDealInput } from './sales.validation.js';

const DEFAULT_STAGES = [
  { name: 'New', kind: 'open' },
  { name: 'Qualified', kind: 'open' },
  { name: 'Proposal', kind: 'open' },
  { name: 'Negotiation', kind: 'open' },
  { name: 'Won', kind: 'won' },
  { name: 'Lost', kind: 'lost' },
] as const;

class SalesService {
  // Lazily seeds the default pipeline; the partial unique index makes concurrent seeding safe.
  private async ensureDefaultPipeline(organizationId: string) {
    const existing = await salesRepository.findDefaultPipeline({ organizationId });
    if (existing) return existing;

    await withTransaction(async (tx) => {
      const created = await salesRepository.insertDefaultPipeline({ organizationId }, tx);
      if (!created) return;
      await salesRepository.insertStages({ stages: DEFAULT_STAGES.map((s, position) => ({ ...s, organizationId, pipelineId: created.id, position })) }, tx);
    });
    const pipeline = await salesRepository.findDefaultPipeline({ organizationId });
    return pipeline!;
  }

  private async assertReferences(organizationId: string, input: { contactId?: string | null; companyId?: string | null }) {
    if (input.contactId && !(await salesRepository.contactExists({ organizationId, id: input.contactId }))) {
      throw new BadRequestError('Contact not found', 'INVALID_CONTACT');
    }
    if (input.companyId && !(await salesRepository.companyExists({ organizationId, id: input.companyId }))) {
      throw new BadRequestError('Company not found', 'INVALID_COMPANY');
    }
  }

  private async getStage(organizationId: string, stageId: string) {
    const stage = await salesRepository.findStage({ organizationId, id: stageId });
    if (!stage) throw new BadRequestError('Stage not found', 'INVALID_STAGE');
    return stage;
  }

  listDeals({ organizationId, query }: { organizationId: string; query: DealListQuery }) {
    return customFieldsService
      .assertFilterKeys({ organizationId, entityType: 'deal', cf: query.cf })
      .then(() => salesRepository.listDeals({ organizationId, query }));
  }

  async getBoard({ organizationId }: { organizationId: string }) {
    const pipeline = await this.ensureDefaultPipeline(organizationId);
    const [stages, allDeals] = await Promise.all([
      salesRepository.listStages({ pipelineId: pipeline.id }),
      salesRepository.listDealsForPipeline({ organizationId, pipelineId: pipeline.id }),
    ]);
    return { pipeline, stages: stages.map((stage) => ({ ...stage, deals: allDeals.filter((d) => d.stageId === stage.id) })) };
  }

  async getDeal({ organizationId, id }: { organizationId: string; id: string }) {
    const deal = await salesRepository.findDeal({ organizationId, id });
    if (!deal) throw new NotFoundError('Deal not found');
    return deal;
  }

  async createDeal({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateDealInput }) {
    await this.assertReferences(organizationId, input);
    const pipeline = await this.ensureDefaultPipeline(organizationId);
    const stage = input.stageId ? await this.getStage(organizationId, input.stageId) : await salesRepository.findFirstStage({ pipelineId: pipeline.id });
    if (!stage) throw new BadRequestError('Stage not found', 'INVALID_STAGE');
    const { stageId: _ignored, ...fields } = input;
    const customFields = await customFieldsService.resolve({ organizationId, entityType: 'deal', input: input.customFields, partial: false });
    return salesRepository.createDeal({
      organizationId,
      ownerId: userId,
      pipelineId: stage.pipelineId,
      stageId: stage.id,
      position: await salesRepository.nextPosition({ organizationId, stageId: stage.id }),
      fields: { ...fields, customFields },
    });
  }

  async updateDeal({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateDealInput }) {
    await this.assertReferences(organizationId, input);
    const customFields = await customFieldsService.resolve({ organizationId, entityType: 'deal', input: input.customFields, partial: true });
    const deal = await salesRepository.updateDeal({ organizationId, id, input: { ...input, customFields } });
    if (!deal) throw new NotFoundError('Deal not found');
    return deal;
  }

  async moveDeal({ organizationId, id, input, actorId }: { organizationId: string; id: string; input: MoveDealInput; actorId?: string }) {
    const deal = await this.getDeal({ organizationId, id });
    const stage = await this.getStage(organizationId, input.stageId);
    if (stage.pipelineId !== deal.pipelineId) throw new BadRequestError('Stage belongs to another pipeline', 'INVALID_STAGE');
    const moved = await salesRepository.moveDeal({
      organizationId,
      id,
      stageId: input.stageId,
      position: await salesRepository.nextPosition({ organizationId, stageId: input.stageId }),
      lostReason: stage.kind === 'lost' ? (input.lostReason ?? null) : null,
    });
    if (stage.kind === 'won' || stage.kind === 'lost') {
      await notify({
        organizationId,
        userId: deal.ownerId,
        actorId,
        type: `deal_${stage.kind}`,
        title: `Deal ${stage.kind}`,
        body: deal.title,
        link: '/deals',
        relatedType: 'deal',
        relatedId: deal.id,
      });
    }
    return moved;
  }

  // Soft delete: related tasks and activity stay, so a restore brings everything back.
  async deleteDeal({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }) {
    if (!(await salesRepository.deleteDeal({ organizationId, id, userId }))) throw new NotFoundError('Deal not found');
  }

  listDeletedDeals({ organizationId, query }: { organizationId: string; query: ListQuery }) {
    return salesRepository.listDeletedDeals({ organizationId, query });
  }

  async restoreDeal({ organizationId, id }: { organizationId: string; id: string }) {
    const deal = await salesRepository.restoreDeal({ organizationId, id }).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictError('Deal can no longer be restored: a unique value was reused', 'RESTORE_CONFLICT');
      throw error;
    });
    if (!deal) throw new NotFoundError('Deleted deal not found');
    return deal;
  }
}

export const salesService = new SalesService();
