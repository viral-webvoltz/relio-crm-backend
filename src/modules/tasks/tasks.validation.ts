import { z } from 'zod';
import { batchSchema } from '@/shared/batch/index.js';
import { listQuerySchema } from '@/shared/pagination/index.js';
import { relatedTypes } from '@/modules/activities/activities.related.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const taskPriorities = ['low', 'medium', 'high'] as const;
export const taskStatuses = ['open', 'done'] as const;
export const taskRecurrences = ['none', 'daily', 'weekly', 'monthly'] as const;

// No defaults in the base: partial() keeps defaults, which would overwrite fields on PATCH.
const taskFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: optionalText(5000),
  dueDate: dateString
    .or(z.literal(''))
    .transform((v) => v || null)
    .nullish(),
  priority: z.enum(taskPriorities),
  status: z.enum(taskStatuses),
  recurrence: z.enum(taskRecurrences),
  assignedTo: z.uuid().nullish(),
});

export const createTaskSchema = taskFields
  .omit({ status: true })
  .extend({
    priority: taskFields.shape.priority.default('medium'),
    recurrence: taskFields.shape.recurrence.default('none'),
    relatedType: z.enum(relatedTypes).nullish(),
    relatedId: z.uuid().nullish(),
  })
  .refine((t) => Boolean(t.relatedType) === Boolean(t.relatedId), { message: 'relatedType and relatedId go together', path: ['relatedId'] })
  .refine((t) => t.recurrence === 'none' || Boolean(t.dueDate), { message: 'A repeating task needs a due date', path: ['dueDate'] });

// The link to a record is fixed at creation.
export const updateTaskSchema = taskFields.partial();

export const taskListQuerySchema = listQuerySchema.extend({
  status: z.enum(taskStatuses).optional(),
  assignee: z.union([z.literal('me'), z.uuid()]).optional(),
  relatedType: z.enum(relatedTypes).optional(),
  relatedId: z.uuid().optional(),
  dueFrom: dateString.optional(),
  dueTo: dateString.optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type TaskRecurrence = (typeof taskRecurrences)[number];

// Fields a bulk update may change; everything else is rejected.
export const batchTasksSchema = batchSchema(updateTaskSchema.pick({ status: true, priority: true, assignedTo: true, dueDate: true }));
export type BatchTasksInput = z.infer<typeof batchTasksSchema>;
