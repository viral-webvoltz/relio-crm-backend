import { and, eq } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { emailTemplates } from '@/database/schema/email-templates.js';
import { BadRequestError } from '@/shared/errors/index.js';
import {
  defaultTemplates,
  renderTemplate,
  SAMPLE_VARIABLES,
  templateKeys,
  templateVariables,
  unknownPlaceholders,
  type TemplateContent,
  type TemplateKey,
} from './mail.templates.js';

class EmailTemplatesService {
  private async findOverride(organizationId: string, key: TemplateKey): Promise<TemplateContent | undefined> {
    const [row] = await db
      .select({ subject: emailTemplates.subject, bodyHtml: emailTemplates.bodyHtml, bodyText: emailTemplates.bodyText })
      .from(emailTemplates)
      .where(and(eq(emailTemplates.organizationId, organizationId), eq(emailTemplates.key, key)));
    return row;
  }

  // Org override if present, else the default in code.
  async render(organizationId: string, key: TemplateKey, vars: Record<string, string | number | null | undefined>) {
    const content = (await this.findOverride(organizationId, key)) ?? defaultTemplates[key];
    return renderTemplate(content, key, vars);
  }

  async list(organizationId: string) {
    const rows = await db.select().from(emailTemplates).where(eq(emailTemplates.organizationId, organizationId));
    return templateKeys.map((key) => {
      const row = rows.find((r) => r.key === key);
      const content = row ?? defaultTemplates[key];
      return {
        key,
        subject: content.subject,
        bodyHtml: content.bodyHtml,
        bodyText: content.bodyText,
        isOverridden: Boolean(row),
        variables: templateVariables[key],
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async put({ organizationId, userId, key, input }: { organizationId: string; userId: string; key: TemplateKey; input: TemplateContent }) {
    const unknown = unknownPlaceholders(`${input.subject}\n${input.bodyHtml}\n${input.bodyText}`, templateVariables[key]);
    if (unknown.length) throw new BadRequestError(`Unknown placeholders: ${unknown.join(', ')}`, 'UNKNOWN_PLACEHOLDERS');
    const values = { ...input, updatedBy: userId, updatedAt: new Date() };
    await db
      .insert(emailTemplates)
      .values({ organizationId, key, ...values })
      .onConflictDoUpdate({ target: [emailTemplates.organizationId, emailTemplates.key], set: values });
    return (await this.list(organizationId)).find((t) => t.key === key);
  }

  async reset(organizationId: string, key: TemplateKey) {
    await db.delete(emailTemplates).where(and(eq(emailTemplates.organizationId, organizationId), eq(emailTemplates.key, key)));
  }

  // Renders the given content (or the current one) with sample data; nothing is sent.
  async preview(organizationId: string, key: TemplateKey, draft?: TemplateContent) {
    const content = draft ?? (await this.findOverride(organizationId, key)) ?? defaultTemplates[key];
    return renderTemplate(content, key, SAMPLE_VARIABLES[key]);
  }
}

export const emailTemplatesService = new EmailTemplatesService();
