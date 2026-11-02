import { BadRequestError } from '@/shared/errors/index.js';
import { preferencesRepository } from './preferences.repository.js';
import { parsePreferenceValue } from './preferences.validation.js';

class PreferencesService {
  async list({ userId }: { userId: string }) {
    const rows = await preferencesRepository.listByUser({ userId });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async set({ userId, organizationId, key, value }: { userId: string; organizationId: string; key: string; value: unknown }) {
    const parsed = parsePreferenceValue(key, value);
    if (parsed === undefined) throw new BadRequestError('Invalid preference value');
    await preferencesRepository.upsert({ userId, organizationId, key, value: parsed });
    return { key, value: parsed };
  }
}

export const preferencesService = new PreferencesService();
