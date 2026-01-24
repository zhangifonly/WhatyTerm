/**
 * UpdateService - 应用更新服务
 *
 * 功能：
 * 1. 检查 GitHub Release 获取最新版本
 * 2. 比较版本号判断是否需要更新
 * 3. 提供更新信息给前端
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 更新服务器配置
const UPDATE_CONFIG = {
  // GitHub Release API
  githubOwner: 'zhangifonly',
  githubRepo: 'WhatyTerm',
  // 自托管更新服务器
  updateServerUrl: 'https://term.whaty.org',
  // 检查间隔（毫秒）
  checkInterval: 3600000, // 1小时
};

class UpdateService {
  constructor() {
    this.currentVersion = null;
    this.latestVersion = null;
    this.updateInfo = null;
    this.lastCheckTime = null;
    this.isChecking = false;
  }

  /**
   * 获取当前版本
   */
  getCurrentVersion() {
    if (this.currentVersion) {
      return this.currentVersion;
    }

    try {
      // 从 package.json 读取版本
      const packagePath = path.join(__dirname, '../../package.json');
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      this.currentVersion = packageJson.version;
      return this.currentVersion;
    } catch (error) {
      console.error('[UpdateService] 读取版本失败:', error.message);
      return '0.0.0';
    }
  }

  /**
   * 比较版本号
   * @returns {number} 1: v1 > v2, -1: v1 < v2, 0: v1 == v2
   */
  compareVersions(v1, v2) {
    const parts1 = v1.replace(/^v/, '').split('.').map(Number);
    const parts2 = v2.replace(/^v/, '').split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  }

  /**
   * 从 GitHub Release 检查更新
   */
  async checkFromGitHub() {
    const url = `https://api.github.com/repos/${UPDATE_CONFIG.githubOwner}/${UPDATE_CONFIG.githubRepo}/releases/latest`;

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'WhatyTerm-Updater'
        }
      });

      if (!response.ok) {
        throw new Error(`GitHub API 返回 ${response.status}`);
      }

      const release = await response.json();

      return {
        version: release.tag_name.replace(/^v/, ''),
        notes: release.body || '',
        pubDate: release.published_at,
        htmlUrl: release.html_url,
        assets: release.assets.map(asset => ({
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size
        }))
      };
    } catch (error) {
      console.error('[UpdateService] GitHub 检查失败:', error.message);
      return null;
    }
  }

  /**
   * 从自托管服务器检查更新
   */
  async checkFromServer() {
    const url = `${UPDATE_CONFIG.updateServerUrl}/latest.json`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'WhatyTerm-Updater'
        }
      });

      if (!response.ok) {
        throw new Error(`服务器返回 ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('[UpdateService] 服务器检查失败:', error.message);
      return null;
    }
  }

  /**
   * 检查更新
   * @param {boolean} force - 是否强制检查（忽略缓存）
   */
  async checkForUpdate(force = false) {
    // 防止并发检查
    if (this.isChecking) {
      return this.updateInfo;
    }

    // 检查缓存
    if (!force && this.lastCheckTime) {
      const elapsed = Date.now() - this.lastCheckTime;
      if (elapsed < UPDATE_CONFIG.checkInterval && this.updateInfo !== null) {
        return this.updateInfo;
      }
    }

    this.isChecking = true;

    try {
      const currentVersion = this.getCurrentVersion();
      console.log(`[UpdateService] 当前版本: ${currentVersion}`);

      // 优先从自托管服务器检查，失败则从 GitHub 检查
      let releaseInfo = await this.checkFromServer();
      if (!releaseInfo) {
        releaseInfo = await this.checkFromGitHub();
      }

      if (!releaseInfo) {
        // 没有发布版本信息时，认为当前已是最新版本
        this.updateInfo = {
          hasUpdate: false,
          currentVersion,
          latestVersion: currentVersion,
          message: '已是最新版本'
        };
        this.lastCheckTime = Date.now();
        return this.updateInfo;
      }

      const latestVersion = releaseInfo.version;
      this.latestVersion = latestVersion;

      const hasUpdate = this.compareVersions(latestVersion, currentVersion) > 0;

      this.updateInfo = {
        hasUpdate,
        currentVersion,
        latestVersion,
        notes: releaseInfo.notes,
        pubDate: releaseInfo.pubDate,
        downloadUrl: releaseInfo.htmlUrl || `${UPDATE_CONFIG.updateServerUrl}/v${latestVersion}/`,
        assets: releaseInfo.assets || []
      };

      this.lastCheckTime = Date.now();

      if (hasUpdate) {
        console.log(`[UpdateService] 发现新版本: ${latestVersion}`);
      } else {
        console.log(`[UpdateService] 已是最新版本`);
      }

      return this.updateInfo;
    } catch (error) {
      console.error('[UpdateService] 检查更新失败:', error);
      // 检查失败时，认为当前已是最新版本（避免显示错误）
      const currentVersion = this.getCurrentVersion();
      this.updateInfo = {
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        message: '已是最新版本'
      };
      return this.updateInfo;
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * 获取下载链接
   * @param {string} platform - 平台 (darwin, win32, linux)
   * @param {string} arch - 架构 (x64, arm64)
   */
  getDownloadUrl(platform, arch) {
    if (!this.updateInfo || !this.updateInfo.hasUpdate) {
      return null;
    }

    const version = this.latestVersion;
    const baseUrl = `${UPDATE_CONFIG.updateServerUrl}/v${version}`;

    // 根据平台和架构返回对应的下载链接
    const fileMap = {
      'darwin-x64': `WhatyTerm-${version}.dmg`,
      'darwin-arm64': `WhatyTerm-${version}-arm64.dmg`,
      'win32-x64': `WhatyTerm Setup ${version}.exe`,
      'linux-x64': `WhatyTerm-${version}.AppImage`
    };

    const key = `${platform}-${arch}`;
    const filename = fileMap[key];

    if (filename) {
      return `${baseUrl}/${encodeURIComponent(filename)}`;
    }

    // 尝试从 assets 中查找
    if (this.updateInfo.assets) {
      const asset = this.updateInfo.assets.find(a => {
        const name = a.name.toLowerCase();
        if (platform === 'darwin') {
          return name.includes('.dmg') && (arch === 'arm64' ? name.includes('arm64') : !name.includes('arm64'));
        } else if (platform === 'win32') {
          return name.includes('.exe');
        } else if (platform === 'linux') {
          return name.includes('.appimage');
        }
        return false;
      });
      return asset?.url || null;
    }

    return null;
  }
}

// 单例导出
const updateService = new UpdateService();
export default updateService;
