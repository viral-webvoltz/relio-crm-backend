import type { PermissionKey } from '@/shared/constants/permissions.js';
import { amountIn, compareIn, currenciesOf, net, primaryCurrency, type Money } from './dashboard.currency.js';
import { dashboardRepository } from './dashboard.repository.js';
import { resolveRange, type SummaryQuery } from './dashboard.validation.js';

const compare = <T>(value: T, previous: T) => ({ value, previous });
const sumOf = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
const rate = (part: number, total: number) => (total === 0 ? 0 : Math.round((part / total) * 1000) / 10);

class DashboardService {
  // Each section is computed only if the user may view it; the rest stay null.
  // Range-based numbers are { value, previous } (previous = the same-length window right before); open pipeline, contacts, companies, tasks and what is owed stay "now".
  // Money is never converted: flat *Minor fields are in the section's primary currency (see dashboard.currency.ts), `byCurrency` lists every currency.
  async getSummary({
    organizationId,
    userId,
    permissions,
    query,
  }: {
    organizationId: string;
    userId: string;
    permissions: PermissionKey[];
    query: SummaryQuery;
  }) {
    const repo = dashboardRepository;
    const can = (key: PermissionKey) => permissions.includes(key);
    const { current, previous, label } = resolveRange(query);
    const both = <T>(fn: (window: typeof current) => Promise<T>) => Promise.all([fn(current), fn(previous)]);

    const tasks = can('tasks.view')
      ? Promise.all([repo.taskTotals({ organizationId, userId }), repo.upcomingTasks({ organizationId, userId })]).then(([totals, upcoming]) => ({
          ...totals,
          upcoming,
        }))
      : null;

    const leads = can('leads.view')
      ? Promise.all([
          both((window) => repo.leadTotals({ organizationId, window })),
          repo.leadsBySource({ organizationId, window: current }),
          repo.recentLeads({ organizationId, window: current }),
        ]).then(([[now, before], bySource, recent]) => ({
          total: compare(now.total, before.total),
          converted: compare(now.converted, before.converted),
          conversionRate: compare(rate(now.converted, now.total), rate(before.converted, before.total)),
          bySource,
          recent,
        }))
      : null;

    const deals = can('deals.view')
      ? Promise.all([repo.dealsByStage({ organizationId }), both((window) => repo.dealsWon({ organizationId, window }))]).then(([stageRows, [now, before]]) => {
          const money = (rows: { currency: string; valueMinor: number }[]): Money[] => rows.map((r) => ({ currency: r.currency, amount: r.valueMinor }));
          const dealMoney = money(stageRows.flatMap((r) => (r.currency === null ? [] : [{ currency: r.currency, valueMinor: r.valueMinor }])));
          const open = money(stageRows.flatMap((r) => (r.kind === 'open' && r.currency !== null ? [{ currency: r.currency, valueMinor: r.valueMinor }] : [])));
          const won = { now: money(now), before: money(before) };
          const currency = primaryCurrency(open, won.now);

          const stages = new Map<
            string,
            { stageId: string; stage: string; kind: string; count: number; valueMinor: number; byCurrency: { currency: string; valueMinor: number }[] }
          >();
          for (const r of stageRows) {
            const entry = stages.get(r.stageId) ?? { stageId: r.stageId, stage: r.stage, kind: r.kind, count: 0, valueMinor: 0, byCurrency: [] };
            entry.count += r.count;
            if (r.currency !== null) entry.byCurrency.push({ currency: r.currency, valueMinor: r.valueMinor });
            if (r.currency === currency) entry.valueMinor = r.valueMinor;
            stages.set(r.stageId, entry);
          }
          const byStage = [...stages.values()]; // rows arrive in stage order
          return {
            currency,
            openCount: sumOf(byStage.filter((s) => s.kind === 'open')),
            openValueMinor: amountIn(open, currency),
            wonCount: compare(sumOf(now), sumOf(before)),
            wonValueMinor: compareIn(won.now, won.before, currency),
            byCurrency: currenciesOf(dealMoney, won.now, won.before).map((c) => ({
              currency: c,
              openValueMinor: amountIn(open, c),
              wonValueMinor: compareIn(won.now, won.before, c),
            })),
            byStage,
          };
        })
      : null;

    const invoices = can('invoices.view')
      ? Promise.all([repo.invoiceTotals({ organizationId }), both((window) => repo.collected({ organizationId, window }))]).then(([owed, [now, before]]) => {
          const outstanding = owed.map((r) => ({ currency: r.currency, amount: r.outstandingMinor }));
          const overdue = owed.map((r) => ({ currency: r.currency, amount: r.overdueMinor }));
          const collected = { now: net(now.paid, now.refunded), before: net(before.paid, before.refunded) };
          const currency = primaryCurrency(outstanding, collected.now);
          return {
            currency,
            outstandingMinor: amountIn(outstanding, currency),
            overdueMinor: amountIn(overdue, currency),
            overdueCount: owed.reduce((n, r) => n + r.overdueCount, 0),
            collectedMinor: compareIn(collected.now, collected.before, currency),
            byCurrency: currenciesOf(outstanding, collected.now, collected.before).map((c) => ({
              currency: c,
              outstandingMinor: amountIn(outstanding, c),
              overdueMinor: amountIn(overdue, c),
              collectedMinor: compareIn(collected.now, collected.before, c),
            })),
          };
        })
      : null;

    const orders = can('orders.view')
      ? Promise.all([both((window) => repo.ordersCreated({ organizationId, window })), repo.recentOrders({ organizationId, window: current })]).then(
          ([[now, before], recent]) => {
            const total = {
              now: now.map((r) => ({ currency: r.currency, amount: r.totalMinor })),
              before: before.map((r) => ({ currency: r.currency, amount: r.totalMinor })),
            };
            const currency = primaryCurrency(total.now);
            return {
              currency,
              created: compare(sumOf(now), sumOf(before)),
              totalMinor: compareIn(total.now, total.before, currency),
              byCurrency: currenciesOf(total.now, total.before).map((c) => ({ currency: c, totalMinor: compareIn(total.now, total.before, c) })),
              recent,
            };
          },
        )
      : null;

    const [contacts, companies, leadsSummary, dealsSummary, tasksSummary, invoicesSummary, ordersSummary] = await Promise.all([
      can('contacts.view') ? repo.contactCount({ organizationId }) : null,
      can('companies.view') ? repo.companyCount({ organizationId }) : null,
      leads,
      deals,
      tasks,
      invoices,
      orders,
    ]);
    return {
      range: label,
      contacts,
      companies,
      leads: leadsSummary,
      deals: dealsSummary,
      tasks: tasksSummary,
      invoices: invoicesSummary,
      orders: ordersSummary,
    };
  }
}

export const dashboardService = new DashboardService();
