import winston from 'winston';
import { config } from '../config/environment';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }
    if (stack) {
      log += `\n${stack}`;
    }
    return log;
  })
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

export const logger = winston.createLogger({
  silent: config.NODE_ENV === 'test',
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  format: config.NODE_ENV === 'production' ? jsonFormat : logFormat,
  transports: [
    new winston.transports.Console({
      format: config.NODE_ENV === 'production'
        ? jsonFormat
        : winston.format.combine(winston.format.colorize(), logFormat),
    }),
  ],
  exceptionHandlers: [
    new winston.transports.Console(),
  ],
  rejectionHandlers: [
    new winston.transports.Console(),
  ],
});

/**
 * Describe an error for the log without its request. Axios errors carry the request's
 * headers and body (a user's bearer token, or the client secret on a token exchange),
 * so only the HTTP status and the API's error fields are kept.
 */
export function describeError(error: unknown): string {
  const ax = error as { isAxiosError?: boolean; response?: { status?: number; data?: unknown } };
  if (ax?.isAxiosError) {
    const data = (ax.response?.data ?? {}) as { error?: unknown; error_description?: unknown };
    const parts = [`HTTP ${ax.response?.status ?? 'network error'}`];
    if (typeof data.error === 'string') parts.push(data.error);
    if (typeof data.error_description === 'string') parts.push(data.error_description);
    return parts.join(' ');
  }
  if (error instanceof Error) return error.stack || error.message;
  return 'Unknown error';
}

// Stream for morgan HTTP logging
export const httpLogStream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};
