import pino from 'pino';

export const log = pino({
  name: 'analyser-service',
  level: process.env.LOG_LEVEL || 'info',
});
