import type { MonthlyRow } from './reports.buckets.js';

export type RangeLabel = { from: string; to: string };

export type RevenueReport = { range: RangeLabel; rows: MonthlyRow[] };

export type PipelineReport = {
  range: RangeLabel;
  stages: {
    stageId: string;
    stage: string;
    pipelineId: string;
    kind: string;
    position: number;
    currency: string | null;
    dealCount: number;
    valueMinor: number;
    avgAgeDays: number | null;
  }[];
  summary: { won: number; lost: number; winRate: number | null; avgDaysToWon: number | null };
  wonByCurrency: { currency: string; count: number; valueMinor: number; avgValueMinor: number }[];
  notes: string[];
};

export type LeadsReport = {
  range: RangeLabel;
  total: number;
  converted: number;
  conversionRate: number | null;
  byStatus: { status: string; count: number }[];
  bySource: { source: string; count: number }[];
};

export type ReportOutput =
  { type: 'revenue-by-month'; data: RevenueReport } | { type: 'pipeline-velocity'; data: PipelineReport } | { type: 'leads-funnel'; data: LeadsReport };
