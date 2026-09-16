import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export function getConfig(env = process.env) {
  const dataDir = env.IYB_DATA_DIR || join(homedir(), '.iamyourboss');
  return {
    host: env.IYB_HOST || '127.0.0.1',
    port: Number(env.IYB_PORT || 7331),
    baseUrl: env.IYB_URL || `http://127.0.0.1:${Number(env.IYB_PORT || 7331)}`,
    dataDir,
    dbPath: env.IYB_DB_PATH || join(dataDir, 'research-record.json'),
    attachmentsDir: join(dataDir, 'attachments'),
    pidPath: join(dataDir, 'server.pid'),
    logPath: join(dataDir, 'server.log'),
    localHostname: hostname(),
    staleMinutes: Number(env.IYB_STALE_MINUTES || 180),
  };
}
