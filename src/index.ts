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
