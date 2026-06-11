import React, { useState, useEffect, useMemo } from 'react';
import { PIXEL_SCALE, getSpriteShadow } from './ralphSprites';
import './RalphOffice.css';

const STATE_LABEL = { active: '开发中', validating: '验证中', passed: '已通过', failed: '未通过', blocked: '已阻塞', pending: '待执行' };
const STATE_COLOR = { active: '#4a9eff', validating: '#a78bfa', passed: '#4ade80', failed: '#f87171', blocked: '#fb923c', pending: '#6b7280' };
const PHASE_EMOJI = { idle: '⏸', developing: '🤖', validating: '🔍', planning: '📋', paused: '⏸', done: '✅', error: '❌' };
const PHASE_TEXT = { idle: '等待启动', developing: '开发中', validating: '验证中', planning: '规划中', paused: '已暂停', done: '全部完成', error: '出现错误' };

// 任务状态 → 语义状态（驱动小人动画）
function featureState(f, currentTaskId, phase) {
  if (f.id === currentTaskId) return phase === 'validating' ? 'validating' : 'active';
  if (f.status === 'completed') return 'passed';
  if (f.blocked) return 'blocked';
  if (f.status !== 'completed' && (f.retryCount > 0 || f.validationNotes)) return 'failed';
  return 'pending';
}

// 语义状态 + 帧 → 精灵 key
function spriteKeyFor(state, frame) {
  switch (state) {
    case 'active': return frame ? 'typing2' : 'typing1';
    case 'validating': return frame ? 'walk2' : 'walk1';
    case 'passed': return frame ? 'celebrate2' : 'celebrate1';
    case 'failed': case 'blocked': return 'frustrated';
    case 'pending': return 'sleeping';
    default: return 'idle';
  }
}

const fmtTime = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

export default function RalphOffice({ features = [], phase = 'idle', currentTaskId, elapsed = 0, completed = 0, total = 0, theater = false, onToggleTheater }) {
  const [frame, setFrame] = useState(0);
  const [sel, setSel] = useState(null);

  // 双帧切换驱动打字/走动动画
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % 2), 460);
    return () => clearInterval(t);
  }, []);

  const selFeature = useMemo(() => features.find((f) => f.id === sel) || null, [sel, features]);

  return (
    <div className={`ralph-office${theater ? ' theater' : ''}`}>
      <div className="ro-bg" />
      <div className="ro-toolbar">
        <span className="ro-phase">{PHASE_EMOJI[phase] || '🤖'} {PHASE_TEXT[phase] || phase}</span>
        <span className="ro-meter">⏱ {fmtTime(elapsed)} · ✅ {completed}/{total}</span>
        <button className="ro-theater-btn" onClick={onToggleTheater} title={theater ? '退出全屏' : '剧场模式（全屏）'}>
          {theater ? '✕ 退出' : '🎭 全屏'}
        </button>
      </div>

      <div className="ro-floor">
        {features.map((f, i) => {
          const st = featureState(f, currentTaskId, phase);
          const key = spriteKeyFor(st, frame);
          const shadow = getSpriteShadow(key, i);
          return (
            <Workstation key={f.id || i} f={f} st={st} shadow={shadow}
              onClick={() => setSel(sel === f.id ? null : f.id)} />
          );
        })}
        {features.length === 0 && <div className="ro-empty">暂无任务</div>}
      </div>

      {selFeature && <DetailPopup f={selFeature} st={featureState(selFeature, currentTaskId, phase)} onClose={() => setSel(null)} />}
    </div>
  );
}

// 单个工位：像素小人 + 桌面显示器 + 状态
function Workstation({ f, st, shadow, onClick }) {
  return (
    <div className={`ro-station ro-st-${st}`} onClick={onClick} title={f.name}>
      <div className="ro-char-area">
        {st === 'pending' && <span className="ro-zzz">z</span>}
        {st === 'active' && <span className="ro-ind ro-ind-active">⌨</span>}
        {st === 'passed' && <span className="ro-ind ro-ind-pass">★</span>}
        {st === 'failed' && <span className="ro-ind ro-ind-fail">!</span>}
        {st === 'blocked' && <span className="ro-ind ro-ind-block">🚫</span>}
        <div className="ro-char-px" style={{ boxShadow: shadow, transform: `scale(${PIXEL_SCALE})` }} />
      </div>
      <div className="ro-monitor" style={{ boxShadow: `0 0 10px ${STATE_COLOR[st]}` }}>
        <div className={`ro-screen ro-screen-${st}`}>
          {st === 'active' && <><span className="ro-code" /><span className="ro-code short" /><span className="ro-code" /></>}
          {st === 'validating' && '🔍'}
          {st === 'passed' && '✅'}
          {st === 'failed' && '❌'}
          {st === 'blocked' && '⚠️'}
        </div>
      </div>
      <div className="ro-desk" />
      <div className="ro-name">{f.name}</div>
      <span className="ro-chip" style={{ color: STATE_COLOR[st], borderColor: STATE_COLOR[st] }}>{STATE_LABEL[st]}</span>
    </div>
  );
}

// 点击详情弹层
function DetailPopup({ f, st, onClose }) {
  return (
    <div className="ro-detail-mask" onClick={onClose}>
      <div className="ro-detail" onClick={(e) => e.stopPropagation()}>
        <div className="ro-detail-title">{f.id} · {f.name}</div>
        <span className="ro-chip" style={{ color: STATE_COLOR[st], borderColor: STATE_COLOR[st] }}>{STATE_LABEL[st]}</span>
        {f.description && <div className="ro-detail-desc">{f.description}</div>}
        {f.validationNotes && <div className="ro-detail-notes">⚠️ {f.validationNotes}</div>}
        {f.retryCount > 0 && <div className="ro-detail-retry">重试 {f.retryCount} 次</div>}
        {Array.isArray(f.acceptanceCriteria) && f.acceptanceCriteria.length > 0 && (
          <div className="ro-detail-ac">
            {f.acceptanceCriteria.map((c, i) => <div key={i} className="ro-ac-line">✓ {c}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}
