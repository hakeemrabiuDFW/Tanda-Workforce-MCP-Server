import { createApp } from './server/app';
import { config } from './config/environment';
import { logger } from './utils/logger';

const app = createApp();

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(`🚀 Tanda Workforce MCP Server started`);
  logger.info(`   Environment: ${config.NODE_ENV}`);
  logger.info(`   Listening on: http://${config.HOST}:${config.PORT}`);
  logger.info(`   MCP endpoint: http://${config.HOST}:${config.PORT}/mcp`);
  logger.info(`   OAuth login: http://${config.HOST}:${config.PORT}/auth/login`);
  logger.info(`   Documentation: http://${config.HOST}:${config.PORT}/docs`);

  if (!config.TANDA_CLIENT_ID || !config.TANDA_CLIENT_SECRET) {
    logger.warn('⚠️  Tanda OAuth credentials not configured. Set TANDA_CLIENT_ID and TANDA_CLIENT_SECRET in environment.');
  }
});

// Configure HTTP server timeouts to prevent premature connection closures
// These are critical for long-lived SSE connections used by MCP
server.keepAliveTimeout = 65000; // 65 seconds (> typical proxy timeout of 60s)
server.headersTimeout = 66000; // Slightly higher than keepAliveTimeout
server.requestTimeout = 0; // Disable request timeout for SSE connections
server.timeout = 0; // Disable socket timeout for long-lived connections

// Server-level error handlers for better debugging and recovery
server.on('error', (error: Error) => {
  logger.error('HTTP server error:', error);
});

server.on('clientError', (error: Error, socket: import('net').Socket) => {
  logger.warn('Client connection error:', error.message);
  if (!socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// Graceful shutdown
const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

export { app };
