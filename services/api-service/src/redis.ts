import Redis from 'ioredis';
import { log } from './logger';

export const redisClient = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false })
  : undefined;

redisClient?.on('error', (err) => log.warn({ err }, 'Redis connection error'));
