import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_PATH = path.join(os.homedir(), '.cc-switch', 'audit.log');
const MAX_LOG_SIZE = 512 * 1024; // 512KB

class CCSwitchAudit {
  log(caller, operation, details) {
    const entry = {
      time: new Date().toISOString(),
      caller,
      operation,
      ...details
    };
    const line = JSON.stringify(entry) + '\n';
    console.log(`[CC-Switch-Audit] ${caller} | ${operation} |`, JSON.stringify(details));
    try {
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG_SIZE) {
        fs.renameSync(LOG_PATH, LOG_PATH + '.old');
      }
      fs.appendFileSync(LOG_PATH, line, 'utf8');
    } catch (e) {
      console.error('[CC-Switch-Audit] 写入日志失败:', e.message);
    }
  }

  startWatcher() {
    const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    if (!fs.existsSync(dbPath)) return;
    try {
      let lastMtime = fs.statSync(dbPath).mtimeMs;
      this._watcher = fs.watchFile(dbPath, { interval: 2000 }, (curr, prev) => {
        if (curr.mtimeMs !== lastMtime) {
          lastMtime = curr.mtimeMs;
          this.log('EXTERNAL_OR_UNKNOWN', 'DB_FILE_CHANGED', {
            prevMtime: new Date(prev.mtimeMs).toISOString(),
            currMtime: new Date(curr.mtimeMs).toISOString(),
            stack: new Error().stack?.split('\n').slice(1, 4).join(' | ')
          });
        }
      });
      console.log('[CC-Switch-Audit] DB 文件监控已启动');
    } catch (e) {
      console.error('[CC-Switch-Audit] 启动文件监控失败:', e.message);
    }
  }

  stopWatcher() {
    const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    if (this._watcher) {
      fs.unwatchFile(dbPath);
      this._watcher = null;
    }
  }
}

export default new CCSwitchAudit();
