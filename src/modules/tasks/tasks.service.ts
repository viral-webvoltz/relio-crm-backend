import { withTransaction } from '@/config/database.js';
import { BadRequestError, NotFoundError } from '@/shared/errors/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { assertRelatedExists } from '@/modules/activities/activities.related.js';
import { notify } from '@/modules/notifications/notifier.js';
import { nextDueDate } from './tasks.recurrence.js';
import { tasksRepository } from './tasks.repository.js';
import type { CreateTaskInput, TaskListQuery, TaskRecurrence, UpdateTaskInput, BatchTasksInput } from './tasks.validation.js';
import { runBatch } from '@/shared/batch/index.js';

class TasksService {
  private async assertAssignee(organizationId: string, assignedTo?: string | null) {
    if (!assignedTo) return;
    if (!(await tasksRepository.assigneeExists({ organizationId, id: assignedTo }))) {
      throw new BadRequestError('Assignee not found', 'INVALID_ASSIGNEE');
    }
  }

  private notifyAssigned(task: { id: string; organizationId: string; title: string; assignedTo: string | null }, actorId?: string) {
    return notify({
      organizationId: task.organizationId,
      userId: task.assignedTo,
      actorId,
      type: 'task_assigned',
      title: 'Task assigned to you',
      body: task.title,
      link: '/tasks',
      relatedType: 'task',
      relatedId: task.id,
    });
  }

  async listTasks({ organizationId, userId, query }: { organizationId: string; userId: string; query: TaskListQuery }) {
    return tasksRepository.list({ organizationId, userId, query });
  }

  async getTask({ organizationId, id }: { organizationId: string; id: string }) {
    const task = await tasksRepository.findById({ organizationId, id });
    if (!task) throw new NotFoundError('Task not found');
    return task;
  }

  async createTask({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateTaskInput }) {
    await this.assertAssignee(organizationId, input.assignedTo);
    if (input.relatedType && input.relatedId) await assertRelatedExists(organizationId, input.relatedType, input.relatedId);
    const task = await tasksRepository.create({ values: { ...input, organizationId, createdBy: userId, assignedTo: input.assignedTo ?? userId } });
    await this.notifyAssigned(task, userId);
    return task;
  }

  // Completing a repeating task spawns the next occurrence. The row lock makes two simultaneous
  // "complete" requests safe: only the one that sees the task still open creates the next one.
  async updateTask({ organizationId, id, input, actorId }: { organizationId: string; id: string; input: UpdateTaskInput; actorId?: string }) {
    let previousAssignee: string | null = null;
    const updated = await withTransaction(async (tx) => {
      await this.assertAssignee(organizationId, input.assignedTo);
      const current = await tasksRepository.findByIdForUpdate({ organizationId, id }, tx);
      if (!current) throw new NotFoundError('Task not found');
      previousAssignee = current.assignedTo;

      const isCompleting = input.status === 'done' && current.status === 'open';
      const isReopening = input.status === 'open' && current.status === 'done';
      const task = await tasksRepository.update({ organizationId, id, input, completedAt: isCompleting ? new Date() : isReopening ? null : undefined }, tx);

      if (isCompleting && current.recurrence !== 'none' && current.dueDate) {
        await tasksRepository.create(
          {
            values: {
              organizationId,
              title: current.title,
              description: current.description,
              priority: current.priority,
              recurrence: current.recurrence,
              assignedTo: current.assignedTo,
              relatedType: current.relatedType,
              relatedId: current.relatedId,
              createdBy: current.createdBy,
              dueDate: nextDueDate(current.dueDate, current.recurrence as Exclude<TaskRecurrence, 'none'>),
            },
          },
          tx,
        );
      }
      return task;
    });
    if (input.assignedTo && input.assignedTo !== previousAssignee) await this.notifyAssigned(updated, actorId);
    return updated;
  }

  async deleteTask({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }) {
    if (!(await tasksRepository.delete({ organizationId, id, userId }))) throw new NotFoundError('Task not found');
  }

  listDeletedTasks({ organizationId, query }: { organizationId: string; query: ListQuery }) {
    return tasksRepository.listDeleted({ organizationId, query });
  }

  async restoreTask({ organizationId, id }: { organizationId: string; id: string }) {
    const task = await tasksRepository.restore({ organizationId, id });
    if (!task) throw new NotFoundError('Deleted task not found');
    return task;
  }

  // Same code path as the single-record endpoints, one item at a time.
  batch({ organizationId, userId, input }: { organizationId: string; userId: string; input: BatchTasksInput }) {
    return runBatch(input.ids, (id) =>
      input.action === 'delete' ? this.deleteTask({ organizationId, id, userId }) : this.updateTask({ organizationId, id, input: input.changes }),
    );
  }
}

export const tasksService = new TasksService();
