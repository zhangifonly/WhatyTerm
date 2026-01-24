import React, { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';
import './ScheduleManager.css';

const ScheduleManager = ({ socket, sessionId, projectPath, onClose }) => {
  const { t } = useTranslation();
  const [schedules, setSchedules] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [formData, setFormData] = useState({
    type: 'daily',
    action: 'enable',
    time: '09:00',
    weekdays: [],
    date: ''
  });

  // 周几选项
  const weekdayOptions = [
    { value: 0, label: t('schedule.weekdays.sun') },
    { value: 1, label: t('schedule.weekdays.mon') },
    { value: 2, label: t('schedule.weekdays.tue') },
    { value: 3, label: t('schedule.weekdays.wed') },
    { value: 4, label: t('schedule.weekdays.thu') },
    { value: 5, label: t('schedule.weekdays.fri') },
    { value: 6, label: t('schedule.weekdays.sat') }
  ];

  // 预约类型选项
  const typeOptions = [
    { value: 'daily', label: t('schedule.types.daily'), icon: '📅' },
    { value: 'weekly', label: t('schedule.types.weekly'), icon: '📆' },
    { value: 'weekdays', label: t('schedule.types.weekdays'), icon: '🗓️' },
    { value: 'once', label: t('schedule.types.once'), icon: '⏰' }
  ];

  // 动作类型选项
  const actionOptions = [
    { value: 'enable', label: t('schedule.actions.enable'), icon: '🟢' },
    { value: 'disable', label: t('schedule.actions.disable'), icon: '🔴' }
  ];

  useEffect(() => {
    console.log('[ScheduleManager] useEffect triggered, socket:', !!socket, 'projectPath:', projectPath);
    if (!socket || !projectPath) {
      console.log('[ScheduleManager] Missing socket or projectPath, returning');
      return;
    }

    // 获取预约列表（基于项目路径）
    console.log('[ScheduleManager] Emitting schedule:getList for projectPath:', projectPath);
    socket.emit('schedule:getList', { projectPath });

    // 监听预约列表更新
    const handleList = (data) => {
      console.log('[ScheduleManager] Received schedule:list, data:', data);
      setSchedules(data);
    };

    const handleCreated = () => {
      setShowForm(false);
      setEditingSchedule(null);
      resetForm();
    };

    const handleUpdated = () => {
      setShowForm(false);
      setEditingSchedule(null);
      resetForm();
    };

    const handleDeleted = () => {
      // 列表会自动更新
    };

    const handleError = (data) => {
      alert(t('schedule.error') + ': ' + data.error);
    };

    socket.on('schedule:list', handleList);
    socket.on('schedule:created', handleCreated);
    socket.on('schedule:updated', handleUpdated);
    socket.on('schedule:deleted', handleDeleted);
    socket.on('schedule:error', handleError);

    return () => {
      socket.off('schedule:list', handleList);
      socket.off('schedule:created', handleCreated);
      socket.off('schedule:updated', handleUpdated);
      socket.off('schedule:deleted', handleDeleted);
      socket.off('schedule:error', handleError);
    };
  }, [socket, projectPath, t]);

  const resetForm = () => {
    setFormData({
      type: 'daily',
      action: 'enable',
      time: '09:00',
      weekdays: [],
      date: ''
    });
  };

  const handleCreate = () => {
    setEditingSchedule(null);
    resetForm();
    setShowForm(true);
  };

  const handleEdit = (schedule) => {
    setEditingSchedule(schedule);
    setFormData({
      type: schedule.type,
      action: schedule.action,
      time: schedule.time,
      weekdays: schedule.weekdays || [],
      date: schedule.date || ''
    });
    setShowForm(true);
  };

  const handleDelete = (id) => {
    if (confirm(t('schedule.confirmDelete'))) {
      socket.emit('schedule:delete', { id });
    }
  };

  const handleToggle = (id, enabled) => {
    socket.emit('schedule:toggle', { id, enabled });
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    // 验证
    if (formData.type === 'weekdays' && formData.weekdays.length === 0) {
      alert(t('schedule.validation.selectWeekdays'));
      return;
    }

    if (formData.type === 'once' && !formData.date) {
      alert(t('schedule.validation.selectDate'));
      return;
    }

    const data = {
      projectPath,
      sessionId,  // 保留 sessionId 用于执行时找到对应会话
      type: formData.type,
      action: formData.action,
      time: formData.time,
      weekdays: formData.type === 'weekdays' ? formData.weekdays : undefined,
      date: formData.type === 'once' ? formData.date : undefined,
      enabled: true
    };

    if (editingSchedule) {
      socket.emit('schedule:update', { id: editingSchedule.id, ...data });
    } else {
      socket.emit('schedule:create', data);
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingSchedule(null);
    resetForm();
  };

  const toggleWeekday = (day) => {
    const newWeekdays = formData.weekdays.includes(day)
      ? formData.weekdays.filter(d => d !== day)
      : [...formData.weekdays, day].sort((a, b) => a - b);
    setFormData({ ...formData, weekdays: newWeekdays });
  };

  const formatScheduleTime = (schedule) => {
    const typeLabel = typeOptions.find(t => t.value === schedule.type)?.label || schedule.type;
    const actionLabel = actionOptions.find(a => a.value === schedule.action)?.label || schedule.action;

    let timeDesc = '';
    switch (schedule.type) {
      case 'daily':
        timeDesc = t('schedule.timeDesc.daily', { time: schedule.time });
        break;
      case 'weekly':
        timeDesc = t('schedule.timeDesc.weekly', { time: schedule.time });
        break;
      case 'weekdays':
        const days = (schedule.weekdays || []).map(d =>
          weekdayOptions.find(w => w.value === d)?.label
        ).join(', ');
        timeDesc = t('schedule.timeDesc.weekdays', { days, time: schedule.time });
        break;
      case 'once':
        timeDesc = t('schedule.timeDesc.once', { date: schedule.date, time: schedule.time });
        break;
    }

    return { typeLabel, actionLabel, timeDesc };
  };

  const formatNextRun = (timestamp) => {
    if (!timestamp) return t('schedule.noNextRun');
    const date = new Date(timestamp);
    const now = new Date();
    const diff = date - now;

    if (diff < 0) return t('schedule.expired');

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) return t('schedule.nextRun.days', { days, hours });
    if (hours > 0) return t('schedule.nextRun.hours', { hours, minutes });
    return t('schedule.nextRun.minutes', { minutes });
  };

  return (
    <div className="schedule-manager-overlay" onClick={onClose}>
      <div className="schedule-manager" onClick={(e) => e.stopPropagation()}>
        <div className="schedule-header">
          <h2>{t('schedule.title')}</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>

        {!showForm ? (
          <div className="schedule-content">
            <div className="schedule-list">
              {schedules.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-icon">📅</span>
                  <p>{t('schedule.empty')}</p>
                </div>
              ) : (
                schedules.map(schedule => {
                  const { typeLabel, actionLabel, timeDesc } = formatScheduleTime(schedule);
                  return (
                    <div key={schedule.id} className={`schedule-item ${!schedule.enabled ? 'disabled' : ''}`}>
                      <div className="schedule-item-main">
                        <div className="schedule-item-header">
                          <span className={`schedule-action ${schedule.action}`}>
                            {actionOptions.find(a => a.value === schedule.action)?.icon}
                            {actionLabel}
                          </span>
                          <span className="schedule-type">
                            {typeOptions.find(t => t.value === schedule.type)?.icon}
                            {typeLabel}
                          </span>
                        </div>
                        <div className="schedule-item-time">{timeDesc}</div>
                        <div className="schedule-item-next">
                          {t('schedule.nextRunLabel')}: {formatNextRun(schedule.nextRun)}
                        </div>
                      </div>
                      <div className="schedule-item-actions">
                        <button
                          className={`btn-toggle ${schedule.enabled ? 'enabled' : 'disabled'}`}
                          onClick={() => handleToggle(schedule.id, !schedule.enabled)}
                          title={schedule.enabled ? t('schedule.disable') : t('schedule.enable')}
                        >
                          {schedule.enabled ? '✓' : '○'}
                        </button>
                        <button
                          className="btn-edit"
                          onClick={() => handleEdit(schedule)}
                          title={t('schedule.edit')}
                        >
                          ✏️
                        </button>
                        <button
                          className="btn-delete"
                          onClick={() => handleDelete(schedule.id)}
                          title={t('schedule.delete')}
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="schedule-footer">
              <button className="btn btn-primary" onClick={handleCreate}>
                {t('schedule.createNew')}
              </button>
            </div>
          </div>
        ) : (
          <form className="schedule-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label>{t('schedule.form.action')}</label>
              <div className="action-buttons">
                {actionOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    className={`action-button ${formData.action === option.value ? 'active' : ''}`}
                    onClick={() => setFormData({ ...formData, action: option.value })}
                  >
                    <span>{option.icon}</span>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label>{t('schedule.form.type')}</label>
              <div className="type-buttons">
                {typeOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    className={`type-button ${formData.type === option.value ? 'active' : ''}`}
                    onClick={() => setFormData({ ...formData, type: option.value })}
                  >
                    <span>{option.icon}</span>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {formData.type === 'weekdays' && (
              <div className="form-group">
                <label>{t('schedule.form.weekdays')}</label>
                <div className="weekday-buttons">
                  {weekdayOptions.map(option => (
                    <button
                      key={option.value}
                      type="button"
                      className={`weekday-button ${formData.weekdays.includes(option.value) ? 'active' : ''}`}
                      onClick={() => toggleWeekday(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {formData.type === 'once' && (
              <div className="form-group">
                <label>{t('schedule.form.date')}</label>
                <input
                  type="date"
                  value={formData.date}
                  onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                  min={new Date().toISOString().split('T')[0]}
                  required
                />
              </div>
            )}

            <div className="form-group">
              <label>{t('schedule.form.time')}</label>
              {/* 预设时间快捷按钮 */}
              <div className="preset-time-buttons">
                {['06:00', '08:00', '09:00', '12:00', '18:00', '21:00'].map(preset => (
                  <button
                    key={preset}
                    type="button"
                    className={`preset-time-button ${formData.time === preset ? 'active' : ''}`}
                    onClick={() => setFormData({ ...formData, time: preset })}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              {/* 自定义时间选择器 */}
              <div className="custom-time-picker">
                <select
                  value={formData.time.split(':')[0]}
                  onChange={(e) => {
                    const minutes = formData.time.split(':')[1] || '00';
                    setFormData({ ...formData, time: `${e.target.value}:${minutes}` });
                  }}
                  className="time-select"
                >
                  {Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0')).map(hour => (
                    <option key={hour} value={hour}>{hour}</option>
                  ))}
                </select>
                <span className="time-separator">:</span>
                <select
                  value={formData.time.split(':')[1] || '00'}
                  onChange={(e) => {
                    const hours = formData.time.split(':')[0] || '00';
                    setFormData({ ...formData, time: `${hours}:${e.target.value}` });
                  }}
                  className="time-select"
                >
                  {['00', '15', '30', '45'].map(minute => (
                    <option key={minute} value={minute}>{minute}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={handleCancel}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-primary">
                {editingSchedule ? t('common.save') : t('common.create')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default ScheduleManager;
