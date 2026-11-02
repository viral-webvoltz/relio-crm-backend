import type { Response } from 'express';

interface SuccessOptions<T> {
  statusCode?: number;
  message?: string;
  data?: T;
  meta?: Record<string, unknown>;
}

// The one place success bodies are shaped, so every endpoint returns { success, message, data, meta? }.
export function sendSuccess<T = null>(res: Response, { statusCode = 200, message = 'ok', data, meta }: SuccessOptions<T> = {}) {
  return res.status(statusCode).json({ success: true, message, data: data ?? null, ...(meta && { meta }) });
}
