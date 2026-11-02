import { z } from 'zod';

export const LIST_RESOURCES = ['leads', 'contacts', 'companies', 'deals', 'tasks', 'orders', 'products', 'invoices', 'tickets'] as const;

const columnsValue = z.array(z.string().min(1).max(60)).max(50);

// Each allowed key maps to its value schema; anything else is rejected.
const valueSchemas: Record<string, z.ZodType> = {
  sidebarCollapsed: z.boolean(),
  pageSize: z.number().int().min(5).max(100),
  ...Object.fromEntries(LIST_RESOURCES.map((r) => [`columns.${r}`, columnsValue])),
};

export const keyParamSchema = z.object({
  key: z.string().refine((k) => Object.hasOwn(valueSchemas, k), 'Unknown preference key'),
});

export const putPreferenceSchema = z.object({ value: z.unknown() });

export const parsePreferenceValue = (key: string, value: unknown) => valueSchemas[key]?.parse(value);

export type KeyParams = z.infer<typeof keyParamSchema>;
export type PutPreferenceInput = z.infer<typeof putPreferenceSchema>;
