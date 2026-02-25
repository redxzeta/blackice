import type { Response } from 'express';
import type { ZodType } from 'zod';
import { sendRequestValidationError } from './errors.js';

export function parseBodyOrRespond<T>(
  schema: ZodType<T>,
  body: unknown,
  res: Response
): T | null {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    sendRequestValidationError(res, parsed.error.issues);
    return null;
  }

  return parsed.data;
}
