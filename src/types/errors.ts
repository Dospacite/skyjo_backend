export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function toApiError(err: unknown): ApiErrorBody {
  if (err instanceof AppError) {
    return { error: { code: err.code, message: err.message, details: err.details } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
}
