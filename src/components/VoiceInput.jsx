import { useState, useRef, useEffect, useCallback } from 'react';

// Whisper 模型单例
let whisperPipeline = null;
let whisperLoading = false;
let whisperLoadCallbacks = [];

async function getWhisperPipeline(onProgress) {
  if (whisperPipeline) return whisperPipeline;
  if (whisperLoading) {
    return new Promise((resolve, reject) => {
      whisperLoadCallbacks.push({ resolve, reject });
    });
  }
  whisperLoading = true;
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    const pipe = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-small', {
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      progress_callback: onProgress,
    });
    whisperPipeline = pipe;
    whisperLoadCallbacks.forEach(cb => cb.resolve(pipe));
    whisperLoadCallbacks = [];
    return pipe;
  } catch (err) {
    whisperLoading = false;
    whisperLoadCallbacks.forEach(cb => cb.reject(err));
    whisperLoadCallbacks = [];
    throw err;
  }
}

export default function VoiceInput({ socket, sessionId, enabled, voiceMode = 'confirm' }) {
  const [status, setStatus] = useState('idle'); // idle|loading|ready|recording|transcribing|confirm|correcting|error
  const [loadProgress, setLoadProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [recognizedText, setRecognizedText] = useState('');
  const [editText, setEditText] = useState('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const loadModel = useCallback(async () => {
    if (whisperPipeline) { setStatus('ready'); return; }
    setStatus('loading');
    setLoadProgress(0);
    try {
      await getWhisperPipeline((p) => {
        if (p.status === 'progress' && p.total)
          setLoadProgress(Math.round((p.loaded / p.total) * 100));
      });
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setErrorMsg('模型加载失败: ' + err.message);
    }
  }, []);

  useEffect(() => {
    if (enabled && !whisperPipeline && status === 'idle') loadModel();
  }, [enabled, loadModel, status]);

  const startRecording = async () => {
    if (status !== 'ready') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        await transcribe();
      };
      recorder.start();
      setStatus('recording');
    } catch {
      setStatus('error');
      setErrorMsg('麦克风权限被拒绝');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      setStatus('transcribing');
    }
  };

  const transcribe = async () => {
    try {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const float32 = audioBuffer.getChannelData(0);
      const pipe = await getWhisperPipeline();
      const result = await pipe(float32, { language: 'chinese', task: 'transcribe', chunk_length_s: 30 });
      const text = result.text?.trim() || '';
      if (voiceMode === 'auto') {
        // 直接发送，不弹窗
        if (text && socket && sessionId) {
          socket.emit('terminal:input', { sessionId, input: text });
          setTimeout(() => socket.emit('terminal:input', { sessionId, input: '\r' }), 50);
        }
        setStatus('ready');
      } else {
        setRecognizedText(text);
        setEditText(text);
        setStatus('confirm');
      }
    } catch (err) {
      setStatus('error');
      setErrorMsg('识别失败: ' + err.message);
      setTimeout(() => setStatus('ready'), 3000);
    }
  };

  const sendText = (text) => {
    if (!text || !socket || !sessionId) return;
    socket.emit('terminal:input', { sessionId, input: text });
    setTimeout(() => socket.emit('terminal:input', { sessionId, input: '\r' }), 50);
    setStatus('ready');
  };

  const aiCorrect = () => {
    if (!socket || !sessionId) return;
    setStatus('correcting');
    socket.emit('voice:correct', { sessionId, text: recognizedText }, (result) => {
      if (result?.corrected) {
        setEditText(result.corrected);
      }
      setStatus('confirm');
    });
  };

  const cancel = () => {
    setRecognizedText('');
    setEditText('');
    setStatus('ready');
  };

  if (!enabled) return null;

  return (
    <div className="voice-input-wrap">
      {/* 确认弹窗 */}
      {(status === 'confirm' || status === 'correcting') && (
        <div className="voice-confirm-popup">
          <div className="voice-confirm-header">
            <span>🎤 语音识别结果</span>
            <button className="voice-confirm-close" onClick={cancel}>✕</button>
          </div>
          <textarea
            className="voice-confirm-text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={3}
            disabled={status === 'correcting'}
          />
          <div className="voice-confirm-actions">
            <button
              className="btn btn-primary btn-small"
              onClick={() => sendText(editText)}
              disabled={status === 'correcting' || !editText.trim()}
            >
              发送
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={aiCorrect}
              disabled={status === 'correcting'}
            >
              {status === 'correcting' ? (
                <><span className="loading-spinner-small" /> AI修正中...</>
              ) : 'AI 修正'}
            </button>
            <button className="btn btn-secondary btn-small" onClick={cancel}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 状态提示 */}
      <div className="voice-input-btn-wrap">
        {status === 'loading' && (
          <div className="voice-loading-tip">加载语音模型 {loadProgress}%</div>
        )}
        {status === 'error' && (
          <div className="voice-error-tip" title={errorMsg}>⚠️</div>
        )}
        <button
          className={`voice-btn ${status}`}
          onMouseDown={status === 'ready' ? startRecording : undefined}
          onMouseUp={status === 'recording' ? stopRecording : undefined}
          onTouchStart={status === 'ready' ? startRecording : undefined}
          onTouchEnd={status === 'recording' ? stopRecording : undefined}
          disabled={['loading', 'transcribing', 'confirm', 'correcting'].includes(status)}
          title={
            status === 'loading' ? `加载模型 ${loadProgress}%` :
            status === 'ready' ? '按住说话' :
            status === 'recording' ? '松开识别' :
            status === 'transcribing' ? '识别中...' :
            status === 'confirm' ? '请确认识别结果' : '语音输入'
          }
        >
          {status === 'transcribing' ? (
            <span className="loading-spinner-small" />
          ) : status === 'recording' ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
