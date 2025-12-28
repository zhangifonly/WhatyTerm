/**
 * 终端回放组件
 * 支持时间轴控制、播放/暂停、速度调节
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTranslation } from '../i18n';
import './TerminalPlayback.css';

export default function TerminalPlayback({ sessionId, onClose }) {
  const { t } = useTranslation();
  const terminalRef = useRef(null);
  const terminalInstance = useRef(null);
  const fitAddon = useRef(null);

  // 状态
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);
  const [inputEvents, setInputEvents] = useState([]); // 输入事件列表
  const [timeRange, setTimeRange] = useState(null);
  const [termSize, setTermSize] = useState({ cols: 120, rows: 30 });

  // 播放控制
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const playbackTimer = useRef(null);
  const currentEventIndex = useRef(0);

  // 加载录制数据
  useEffect(() => {
    loadRecordings();
    return () => {
      if (playbackTimer.current) {
        clearTimeout(playbackTimer.current);
      }
    };
  }, [sessionId]);

  // 数据加载完成后初始化终端
  useEffect(() => {
    if (loading || !terminalRef.current || terminalInstance.current) return;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cols: termSize.cols,
      rows: termSize.rows,
      theme: {
        background: '#1a1a2e',
        foreground: '#eee',
        cursor: '#fff',
      },
      scrollback: 5000,
    });

    fitAddon.current = new FitAddon();
    term.loadAddon(fitAddon.current);
    term.open(terminalRef.current);

    terminalInstance.current = term;

    // 渲染初始帧
    if (events.length > 0) {
      const firstTimestamp = events[0].timestamp;
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (event.timestamp - firstTimestamp > 100) break;
        if (event.type === 'o') {
          term.write(event.data);
        }
        currentEventIndex.current = i + 1;
      }
      setCurrentTime(events[currentEventIndex.current - 1]?.timestamp || firstTimestamp);
    }

    return () => {
      term.dispose();
      terminalInstance.current = null;
    };
  }, [loading, termSize, events]);

  const loadRecordings = async () => {
    setLoading(true);
    setError(null);

    try {
      // 获取时间范围和终端尺寸
      const rangeRes = await fetch(`/api/sessions/${sessionId}/recordings/range`);
      const rangeData = await rangeRes.json();

      if (!rangeData.hasRecordings) {
        setError('暂无录制数据');
        setLoading(false);
        return;
      }

      setTimeRange(rangeData);
      if (rangeData.cols && rangeData.rows) {
        setTermSize({ cols: rangeData.cols, rows: rangeData.rows });
      }

      // 先加载前10个数据块快速显示
      const initialRes = await fetch(
        `/api/sessions/${sessionId}/recordings?start=${rangeData.startTime}&end=${rangeData.endTime}&limit=10`
      );
      const initialData = await initialRes.json();

      if (initialData.length === 0) {
        setError('暂无录制数据');
        setLoading(false);
        return;
      }

      // 处理输入事件
      const inputs = extractInputEvents(initialData);
      setInputEvents(inputs);
      setEvents(initialData);
      setCurrentTime(initialData[0].timestamp);
      setLoading(false);

      // 后台加载剩余数据
      const lastTimestamp = initialData[initialData.length - 1]?.timestamp || rangeData.startTime;
      if (lastTimestamp < rangeData.endTime) {
        loadRemainingData(lastTimestamp + 1, rangeData.endTime, initialData, inputs);
      }
    } catch (err) {
      setError('加载录制数据失败');
      setLoading(false);
    }
  };

  // 后台加载剩余数据
  const loadRemainingData = async (startTime, endTime, existingEvents, existingInputs) => {
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/recordings?start=${startTime}&end=${endTime}`
      );
      const moreData = await res.json();

      if (moreData.length > 0) {
        const allEvents = [...existingEvents, ...moreData];
        const moreInputs = extractInputEvents(moreData);
        const allInputs = [...existingInputs, ...moreInputs];

        setEvents(allEvents);
        setInputEvents(allInputs);
      }
    } catch (err) {
      console.error('加载剩余数据失败:', err);
    }
  };

  // 提取输入事件的函数
  const extractInputEvents = (eventsData) => {
    // 清理输入数据
    const cleanInputData = (data) => {
      return data
        // 移除 ESC 序列
        .replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
        .replace(/\x1b[^[]\S*/g, '')
        // 移除方括号序列 [>0;276;0c [<0;105;27M 等
        .replace(/\[[<>?]?[\d;]*[a-zA-Z]/g, '')
        // 移除 OSC 响应
        .replace(/\][\d]+;[^\]\\]*[\\]?/g, '')
        // 移除控制字符
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim();
    };

    // 检查是否为有效输入
    const isValidInput = (data) => {
      // 过滤终端响应和鼠标事件
      if (/\[[<>?]?[\d;]*[a-zA-Z]/.test(data)) return false;
      if (/^\][\d;]/.test(data)) return false;
      if (/^[A-Z]{3,}$/.test(data)) return false;
      if (/rgb:|eaea/i.test(data)) return false;
      if (/^[\[\];<>\d\\\/]+$/.test(data)) return false;
      if (/^\d+;\d+/.test(data)) return false;
      if (/^[ABCDM]+$/.test(data)) return false;
      // 过滤包含大量数字分号的内容
      if ((data.match(/[\d;]/g) || []).length > data.length * 0.5) return false;
      return data.length > 0 && data.length < 500;
    };

    const mergedInputs = [];
    let currentInput = { timestamp: 0, data: '' };

    for (const e of eventsData) {
      if (e.type !== 'i' || !e.data) continue;

      if (e.data === '\r' || e.data === '\n' || e.data === '\r\n') {
        const cleanedData = cleanInputData(currentInput.data);
        if (cleanedData && isValidInput(cleanedData)) {
          mergedInputs.push({ timestamp: currentInput.timestamp, data: cleanedData });
        }
        currentInput = { timestamp: 0, data: '' };
      } else {
        if (!currentInput.timestamp) currentInput.timestamp = e.timestamp;
        currentInput.data += e.data;
      }
    }

    const lastCleanedData = cleanInputData(currentInput.data);
    if (lastCleanedData && isValidInput(lastCleanedData)) {
      mergedInputs.push({ timestamp: currentInput.timestamp, data: lastCleanedData });
    }

    return mergedInputs;
  };

  // 播放控制函数
  const playNextEvent = useCallback(() => {
    if (!terminalInstance.current || events.length === 0) return;

    const idx = currentEventIndex.current;
    if (idx >= events.length) {
      setIsPlaying(false);
      return;
    }

    const event = events[idx];

    if (event.type === 'o') {
      terminalInstance.current.write(event.data);
    }

    setCurrentTime(event.timestamp);
    currentEventIndex.current = idx + 1;

    if (idx + 1 < events.length) {
      const nextEvent = events[idx + 1];
      const delay = Math.max(10, (nextEvent.timestamp - event.timestamp) / playbackSpeed);
      playbackTimer.current = setTimeout(playNextEvent, Math.min(delay, 1000));
    } else {
      setIsPlaying(false);
    }
  }, [events, playbackSpeed]);

  const togglePlay = () => {
    if (isPlaying) {
      if (playbackTimer.current) {
        clearTimeout(playbackTimer.current);
      }
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      playNextEvent();
    }
  };

  const seekTo = (timestamp) => {
    if (!terminalInstance.current || events.length === 0) return;

    if (playbackTimer.current) {
      clearTimeout(playbackTimer.current);
    }
    setIsPlaying(false);

    terminalInstance.current.clear();

    let targetIndex = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].timestamp <= timestamp) {
        targetIndex = i;
      } else {
        break;
      }
    }

    for (let i = 0; i <= targetIndex; i++) {
      if (events[i].type === 'o') {
        terminalInstance.current.write(events[i].data);
      }
    }

    currentEventIndex.current = targetIndex + 1;
    setCurrentTime(timestamp);
  };

  // 跳转到指定时间并自动播放（用于点击输入历史）
  const seekAndPlay = (timestamp) => {
    if (!terminalInstance.current || events.length === 0) return;

    if (playbackTimer.current) {
      clearTimeout(playbackTimer.current);
    }

    terminalInstance.current.clear();

    // 找到该时间戳之前一点的位置（提前500ms）
    const seekTime = Math.max(timestamp - 500, timeRange?.startTime || 0);

    let targetIndex = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].timestamp <= seekTime) {
        targetIndex = i;
      } else {
        break;
      }
    }

    // 渲染到目标位置
    for (let i = 0; i <= targetIndex; i++) {
      if (events[i].type === 'o') {
        terminalInstance.current.write(events[i].data);
      }
    }

    currentEventIndex.current = targetIndex + 1;
    setCurrentTime(seekTime);

    // 自动开始播放
    setIsPlaying(true);
    setTimeout(playNextEvent, 50);
  };

  const formatTime = (ms) => {
    if (!timeRange) return '00:00';
    const seconds = Math.floor((ms - timeRange.startTime) / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="playback-overlay" onClick={onClose}>
      <div className="playback-modal" onClick={(e) => e.stopPropagation()}>
        <div className="playback-header">
          <span>终端回放</span>
          <button className="playback-close" onClick={onClose}>×</button>
        </div>

        <div className="playback-content">
          {loading ? (
            <div className="playback-loading">加载中...</div>
          ) : error ? (
            <div className="playback-error">{error}</div>
          ) : (
            <>
              <div className="playback-main">
                <div className="playback-terminal" ref={terminalRef} />

                {/* 右侧输入列表 */}
                <div className="playback-inputs">
                  <div className="playback-inputs-header">输入历史</div>
                  <div className="playback-inputs-list">
                    {inputEvents.length === 0 ? (
                      <div className="playback-inputs-empty">暂无输入记录</div>
                    ) : (
                      inputEvents.map((input, idx) => (
                        <div
                          key={idx}
                          className={`playback-input-item ${currentTime >= input.timestamp ? 'passed' : ''}`}
                          onClick={() => seekAndPlay(input.timestamp)}
                          title={input.data}
                        >
                          <span className="input-time">{formatTime(input.timestamp)}</span>
                          <span className="input-text">{input.data}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="playback-controls">
                <button className="playback-btn" onClick={togglePlay}>
                  {isPlaying ? '⏸' : '▶'}
                </button>

                <div className="playback-timeline">
                  <input
                    type="range"
                    min={timeRange?.startTime || 0}
                    max={timeRange?.endTime || 100}
                    value={currentTime}
                    onChange={(e) => seekTo(parseInt(e.target.value))}
                  />
                </div>

                <div className="playback-time">
                  {formatTime(currentTime)} / {formatTime(timeRange?.endTime || 0)}
                </div>

                <select
                  className="playback-speed"
                  value={playbackSpeed}
                  onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                >
                  <option value="0.5">0.5x</option>
                  <option value="1">1x</option>
                  <option value="2">2x</option>
                  <option value="4">4x</option>
                  <option value="8">8x</option>
                </select>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
