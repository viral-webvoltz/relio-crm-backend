import { describe, expect, it } from 'vitest';
import { fieldProblem } from './workflows.records.js';

describe('fieldProblem', () => {
  it('lets a template through at save time', () => {
    expect(fieldProblem('leads', 'status', '{{status}}')).toBeNull();
  });

  it('checks template-looking text once it is rendered', () => {
    expect(fieldProblem('leads', 'status', '{{x}}', { rendered: true })).not.toBeNull();
    expect(fieldProblem('leads', 'status', 'qualified', { rendered: true })).toBeNull();
  });

  it('enforces length limits on rendered text', () => {
    expect(fieldProblem('contacts', 'notes', 'x'.repeat(5001), { rendered: true })).not.toBeNull();
  });
});
