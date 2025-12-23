import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, statSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

/**
 * Claude Config Manager
 * 管理 Claude Code 的配置文件 (~/.claude/settings.json)
 */
class ClaudeConfigManager {
  constructor() {
    this.claudeDir = join(homedir(), '.claude');
    this.settingsPath = join(this.claudeDir, 'settings.json');
    this.profilesDir = join(this.claudeDir, 'profiles');
    this.templatesDir = join(this.profilesDir, 'templates');
    this.currentMarker = join(this.claudeDir, '.current');
    this.emptyModeMarker = join(this.claudeDir, '.empty_mode');
    this.emptyBackup = join(this.profilesDir, '.empty_backup_settings.json');

    this.ensureDirectories();
  }

  // 确保目录存在
  ensureDirectories() {
    if (!existsSync(this.claudeDir)) {
      mkdirSync(this.claudeDir, { recursive: true });
    }
    if (!existsSync(this.profilesDir)) {
      mkdirSync(this.profilesDir, { recursive: true });
    }
    if (!existsSync(this.templatesDir)) {
      mkdirSync(this.templatesDir, { recursive: true });
      // 创建默认模板
      this.createDefaultTemplate();
    }
  }

  // 创建默认模板
  createDefaultTemplate() {
    const defaultTemplate = {
      env: {
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: ""
      },
      permissions: {
        allow: [],
        deny: []
      },
      statusLine: {}
    };

    const templatePath = join(this.templatesDir, 'default.json');
    if (!existsSync(templatePath)) {
      writeFileSync(templatePath, JSON.stringify(defaultTemplate, null, 2), { mode: 0o600 });
    }
  }

  // ==================== Profile 管理 ====================

  // 列出所有 profiles
  listProfiles() {
    if (!existsSync(this.profilesDir)) {
      return [];
    }

    const files = readdirSync(this.profilesDir);
    const profiles = files
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => {
        const name = f.replace('.json', '');
        const path = join(this.profilesDir, f);
        const stats = statSync(path);
        const isCurrent = this.getCurrentProfile() === name;

        return {
          name,
          path,
          is_current: isCurrent,
          created_at: stats.birthtime,
          modified_at: stats.mtime
        };
      });

    return profiles;
  }

  // 获取当前 profile
  getCurrentProfile() {
    if (this.isEmptyMode()) {
      return null;
    }

    if (existsSync(this.currentMarker)) {
      try {
        return readFileSync(this.currentMarker, 'utf-8').trim();
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  // 设置当前 profile
  setCurrentProfile(name) {
    writeFileSync(this.currentMarker, name, 'utf-8');
  }

  // 检查是否处于空配置模式
  isEmptyMode() {
    return existsSync(this.emptyModeMarker);
  }

  // 获取空配置模式状态
  getEmptyModeStatus() {
    if (!this.isEmptyMode()) {
      return null;
    }

    try {
      const status = JSON.parse(readFileSync(this.emptyModeMarker, 'utf-8'));
      return status;
    } catch (err) {
      return { previous_profile: null };
    }
  }

  // 创建 profile
  createProfile(name, templateName = 'default', customContent = null) {
    const profilePath = join(this.profilesDir, `${name}.json`);

    if (existsSync(profilePath)) {
      throw new Error(`Profile '${name}' already exists`);
    }

    let content;
    if (customContent) {
      content = customContent;
    } else {
      // 从模板创建
      const templatePath = join(this.templatesDir, `${templateName}.json`);
      if (!existsSync(templatePath)) {
        throw new Error(`Template '${templateName}' not found`);
      }
      content = JSON.parse(readFileSync(templatePath, 'utf-8'));
    }

    writeFileSync(profilePath, JSON.stringify(content, null, 2), { mode: 0o600 });
    return { name, path: profilePath };
  }

  // 查看 profile
  viewProfile(name) {
    const profilePath = join(this.profilesDir, `${name}.json`);

    if (!existsSync(profilePath)) {
      throw new Error(`Profile '${name}' not found`);
    }

    const content = JSON.parse(readFileSync(profilePath, 'utf-8'));
    const isCurrent = this.getCurrentProfile() === name;

    return {
      name,
      path: profilePath,
      content,
      is_current: isCurrent
    };
  }

  // 更新 profile
  updateProfile(name, content) {
    const profilePath = join(this.profilesDir, `${name}.json`);

    if (!existsSync(profilePath)) {
      throw new Error(`Profile '${name}' not found`);
    }

    writeFileSync(profilePath, JSON.stringify(content, null, 2), { mode: 0o600 });

    // 如果是当前 profile，同步到 settings.json
    if (this.getCurrentProfile() === name && !this.isEmptyMode()) {
      this.applyProfile(name);
    }
  }

  // 删除 profile
  deleteProfile(name, force = false) {
    const profilePath = join(this.profilesDir, `${name}.json`);

    if (!existsSync(profilePath)) {
      throw new Error(`Profile '${name}' not found`);
    }

    const isCurrent = this.getCurrentProfile() === name;

    if (isCurrent && !force) {
      throw new Error(`Cannot delete current profile '${name}'. Use --current flag to delete and switch to empty mode.`);
    }

    unlinkSync(profilePath);

    if (isCurrent) {
      // 进入空配置模式
      this.useEmptyMode();
    }
  }

  // 重命名 profile
  moveProfile(oldName, newName) {
    const oldPath = join(this.profilesDir, `${oldName}.json`);
    const newPath = join(this.profilesDir, `${newName}.json`);

    if (!existsSync(oldPath)) {
      throw new Error(`Profile '${oldName}' not found`);
    }

    if (existsSync(newPath)) {
      throw new Error(`Profile '${newName}' already exists`);
    }

    renameSync(oldPath, newPath);

    // 更新 current marker
    if (this.getCurrentProfile() === oldName) {
      this.setCurrentProfile(newName);
    }
  }

  // 复制 profile
  copyProfile(sourceName, destName) {
    const sourcePath = join(this.profilesDir, `${sourceName}.json`);
    const destPath = join(this.profilesDir, `${destName}.json`);

    if (!existsSync(sourcePath)) {
      throw new Error(`Profile '${sourceName}' not found`);
    }

    if (existsSync(destPath)) {
      throw new Error(`Profile '${destName}' already exists`);
    }

    copyFileSync(sourcePath, destPath);
  }

  // 应用 profile 到 settings.json
  applyProfile(name) {
    const profilePath = join(this.profilesDir, `${name}.json`);

    if (!existsSync(profilePath)) {
      throw new Error(`Profile '${name}' not found`);
    }

    const content = readFileSync(profilePath, 'utf-8');

    // 备份当前 settings.json
    if (existsSync(this.settingsPath)) {
      const backupPath = `${this.settingsPath}.backup`;
      copyFileSync(this.settingsPath, backupPath);
    }

    // 写入新配置
    writeFileSync(this.settingsPath, content, { mode: 0o600 });

    // 更新 current marker
    this.setCurrentProfile(name);

    // 如果处于空配置模式，退出
    if (this.isEmptyMode()) {
      unlinkSync(this.emptyModeMarker);
      if (existsSync(this.emptyBackup)) {
        unlinkSync(this.emptyBackup);
      }
    }
  }

  // 使用空配置模式
  useEmptyMode() {
    if (this.isEmptyMode()) {
      return; // 已经是空配置模式
    }

    const currentProfile = this.getCurrentProfile();

    // 备份当前 settings.json
    if (existsSync(this.settingsPath)) {
      copyFileSync(this.settingsPath, this.emptyBackup);
      unlinkSync(this.settingsPath);
    }

    // 创建空配置模式标记
    const emptyModeStatus = {
      previous_profile: currentProfile,
      entered_at: new Date().toISOString()
    };
    writeFileSync(this.emptyModeMarker, JSON.stringify(emptyModeStatus, null, 2));
  }

  // 从空配置模式恢复
  restoreFromEmptyMode() {
    if (!this.isEmptyMode()) {
      throw new Error('Not in empty mode');
    }

    const status = this.getEmptyModeStatus();
    const previousProfile = status?.previous_profile;

    if (previousProfile && existsSync(join(this.profilesDir, `${previousProfile}.json`))) {
      this.applyProfile(previousProfile);
    } else {
      // 如果没有之前的 profile，只是退出空配置模式
      if (existsSync(this.emptyBackup)) {
        copyFileSync(this.emptyBackup, this.settingsPath);
        unlinkSync(this.emptyBackup);
      }
      unlinkSync(this.emptyModeMarker);
    }
  }

  // ==================== Template 管理 ====================

  // 列出所有 templates
  listTemplates() {
    if (!existsSync(this.templatesDir)) {
      return [];
    }

    const files = readdirSync(this.templatesDir);
    const templates = files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));

    return templates;
  }

  // 创建 template
  createTemplate(name) {
    const templatePath = join(this.templatesDir, `${name}.json`);

    if (existsSync(templatePath)) {
      throw new Error(`Template '${name}' already exists`);
    }

    const defaultContent = {
      env: {},
      permissions: {
        allow: [],
        deny: []
      },
      statusLine: {}
    };

    writeFileSync(templatePath, JSON.stringify(defaultContent, null, 2), { mode: 0o600 });
    return { name, path: templatePath };
  }

  // 查看 template
  viewTemplate(name) {
    const templatePath = join(this.templatesDir, `${name}.json`);

    if (!existsSync(templatePath)) {
      throw new Error(`Template '${name}' not found`);
    }

    const content = JSON.parse(readFileSync(templatePath, 'utf-8'));

    return {
      name,
      path: templatePath,
      content
    };
  }

  // 更新 template
  updateTemplate(name, content) {
    if (name === 'default') {
      throw new Error('Cannot modify the default template');
    }

    const templatePath = join(this.templatesDir, `${name}.json`);

    if (!existsSync(templatePath)) {
      throw new Error(`Template '${name}' not found`);
    }

    writeFileSync(templatePath, JSON.stringify(content, null, 2), { mode: 0o600 });
  }

  // 删除 template
  deleteTemplate(name) {
    if (name === 'default') {
      throw new Error('Cannot delete the default template');
    }

    const templatePath = join(this.templatesDir, `${name}.json`);

    if (!existsSync(templatePath)) {
      throw new Error(`Template '${name}' not found`);
    }

    unlinkSync(templatePath);
  }

  // 重命名 template
  moveTemplate(oldName, newName) {
    if (oldName === 'default') {
      throw new Error('Cannot move/rename the default template');
    }

    if (newName === 'default') {
      throw new Error('Cannot rename template to reserved name "default"');
    }

    const oldPath = join(this.templatesDir, `${oldName}.json`);
    const newPath = join(this.templatesDir, `${newName}.json`);

    if (!existsSync(oldPath)) {
      throw new Error(`Template '${oldName}' not found`);
    }

    if (existsSync(newPath)) {
      throw new Error(`Template '${newName}' already exists`);
    }

    renameSync(oldPath, newPath);
  }

  // 复制 template
  copyTemplate(sourceName, destName) {
    const sourcePath = join(this.templatesDir, `${sourceName}.json`);
    const destPath = join(this.templatesDir, `${destName}.json`);

    if (!existsSync(sourcePath)) {
      throw new Error(`Template '${sourceName}' not found`);
    }

    if (existsSync(destPath)) {
      throw new Error(`Template '${destName}' already exists`);
    }

    copyFileSync(sourcePath, destPath);
  }

  // ==================== 配置校验 ====================

  // 校验配置是否存在
  profileExists(name) {
    return existsSync(join(this.profilesDir, `${name}.json`));
  }

  // 校验模板是否存在
  templateExists(name) {
    return existsSync(join(this.templatesDir, `${name}.json`));
  }

  // 校验配置名称
  validateProfileName(name) {
    if (!name || name.length === 0) {
      throw new Error('Profile name cannot be empty');
    }

    if (name.length > 255) {
      throw new Error('Profile name must be 255 characters or less');
    }

    const validName = /^[a-zA-Z0-9_-]+$/;
    if (!validName.test(name)) {
      throw new Error('Profile name can only contain letters, numbers, hyphens, and underscores');
    }
  }

  // 校验模板名称
  validateTemplateName(name) {
    if (!name || name.length === 0) {
      throw new Error('Template name cannot be empty');
    }

    if (name.length > 255) {
      throw new Error('Template name must be 255 characters or less');
    }

    const validName = /^[a-zA-Z0-9_-]+$/;
    if (!validName.test(name)) {
      throw new Error('Template name can only contain letters, numbers, hyphens, and underscores');
    }

    if (name === 'default') {
      throw new Error('Cannot use reserved name "default"');
    }
  }
}

export default ClaudeConfigManager;
