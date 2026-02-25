import type { Response } from 'express';

export type HttpErrorShape = {
  status: number;
  message: string;
};

export function errStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }

  return 500;
}

export function errMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function toHttpError(error: unknown): HttpErrorShape {
  return {
    status: errStatus(error),
    message: errMessage(error)
  };
}

export function sendOpenAIError(
  res: Response,
  status: number,
  message: string,
  type = 'invalid_request_error'
): void {
  res.status(status).json({
    error: {
      message,
      type
    }
  });
}

export function sendRequestValidationError(res: Response, details: unknown): void {
  res.status(400).json({
    error: 'Invalid request body',
    details
  });
}

export function sendSimpleError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}
