import { useEffect, useRef, type CSSProperties } from 'react';
import { useRealtimeVoice } from './use-realtime-voice.js';

type Request = (url: string, init?: RequestInit) => Promise<Response>;
type VoiceContext = { server: string; worktree?: string; agent?: string; worktreeId?: string; agentId?: string };
type WorktreeSelection = { worktreeId: string; worktreeLabel: string };

// provide staggered waveform positions
const soundwaveBars = Array.from({ length: 28 }, (_, index) => index);

export type VoiceDialogProps = { open: boolean; callRequest: number; context: VoiceContext; request: Request; onClose: () => void; onSelectWorktree?: (worktreeId: string) => WorktreeSelection | undefined; onActiveChange?: (active: boolean) => void };

// render the responsive voice orchestration surface
export function VoiceDialog({ open, callRequest, context, request, onClose, onSelectWorktree, onActiveChange }: VoiceDialogProps) {
  const voice = useRealtimeVoice(request, { ...(context.worktreeId === undefined ? {} : { worktreeId: context.worktreeId }), ...(context.worktree === undefined ? {} : { worktreeLabel: context.worktree }), ...(context.agentId === undefined ? {} : { agentId: context.agentId }) }, onSelectWorktree);
  const closeButton = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLElement>(null);
  const hangupSound = useRef<HTMLAudioElement>(null);
  const previousVoiceState = useRef(voice.state);
  const handledCallRequest = useRef(callRequest);
  // focus the dialog close control after opening
  useEffect(() => {
    // focus only the fullscreen mobile toggle
    if (open && window.matchMedia('(max-width: 600px)').matches) closeButton.current?.focus();
  }, [open]);
  // start each explicitly requested call once
  useEffect(() => {
    // ignore visibility toggles and handled requests
    if (!open || callRequest === handledCallRequest.current) return;
    handledCallRequest.current = callRequest;
    void voice.start();
  }, [callRequest, open, voice.start]);
  // publish the visible voice mutation gate
  useEffect(() => { onActiveChange?.(voice.state === 'connecting' || voice.state === 'connected'); }, [onActiveChange, voice.state]);
  // publish live levels to the mobile call control
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--davo-output-level', voice.outputLevel.toFixed(3));
    root.style.setProperty('--davo-input-level', voice.inputLevel.toFixed(3));
    root.style.setProperty('--davo-call-level', Math.max(voice.outputLevel, voice.inputLevel).toFixed(3));
  }, [voice.inputLevel, voice.outputLevel]);
  // remove global audio levels after unmounting
  useEffect(() => () => {
    document.documentElement.style.removeProperty('--davo-output-level');
    document.documentElement.style.removeProperty('--davo-input-level');
    document.documentElement.style.removeProperty('--davo-call-level');
  }, []);
  // follow each new transcript update
  useEffect(() => {
    const history = transcript.current;
    // keep the newest message visible
    if (history !== null) history.scrollTop = history.scrollHeight;
  }, [voice.transcript]);
  // finish and dismiss each established call
  useEffect(() => {
    const previous = previousVoiceState.current;
    previousVoiceState.current = voice.state;
    // ignore setup, errors, and non-call transitions
    if (previous !== 'connected' || voice.state !== 'idle' || !voice.endedIntentionally) return;
    const sound = hangupSound.current;
    // skip playback after the dialog audio element unmounts
    if (sound === null) return;
    sound.currentTime = 0;
    void sound.play().catch(() => undefined);
    const dismissal = window.setTimeout(onClose, 2_000);
    // cancel dismissal when another call starts
    return () => window.clearTimeout(dismissal);
  }, [onClose, voice.endedIntentionally, voice.state]);
  // hide without ending the ongoing call
  const close = () => onClose();
  // keep the dialog absent from the accessibility tree while closed
  if (!open) return null;
  const soundwaveStyle = { '--mic-level': voice.inputLevel.toFixed(3), '--davo-level': voice.outputLevel.toFixed(3) } as CSSProperties;
  return <div className="dialog voice-dialog" role="dialog" aria-modal={window.matchMedia('(max-width: 600px)').matches} aria-labelledby="voice-title">
    <div style={soundwaveStyle}>
      <div className="voice-soundwaves" aria-hidden="true"><div className="voice-soundwave davo">{soundwaveBars.map(index => <i key={index} style={{ animationDelay: `${index * -47}ms` }} />)}</div><div className="voice-soundwave mic">{soundwaveBars.map(index => <i key={index} style={{ animationDelay: `${index * -47}ms` }} />)}</div></div>
      <header><div><small>OPENAI REALTIME</small><h2 id="voice-title">Davo</h2></div><button ref={closeButton} className="voice-view-toggle" type="button" aria-label="Ongoing Davo call — show main UI" onClick={close}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.08 9.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.33 1.84.56 2.8.69A2 2 0 0 1 22 16.92Z" /></svg></button></header>
      <section className="voice-context" aria-label="Current target"><span>{context.server}</span>{context.worktree && <span>Active: {context.worktree}</span>}{context.agent && <span>{context.agent}</span>}</section>
      <section ref={transcript} className="voice-transcript" aria-live="polite">
        {voice.transcript.length === 0 ? <p>Ask about agents, worktrees, branches, prompts, reviews, files, or stack status.</p> : voice.transcript.map(entry => <p key={entry.id} className={`voice-${entry.role}`}><strong>{entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Davo' : 'Tool'}</strong><span>{entry.text}</span></p>)}
      </section>
      {voice.toolStatus && <p className="voice-tool-status"><span className="spinner" />{voice.toolStatus}</p>}
      {voice.error && <p className="auth-error" role="alert">{voice.error}</p>}
      {voice.state === 'connecting' && <audio className="voice-ringing" src="/davo-ring.wav" autoPlay loop aria-hidden="true" />}
      <audio ref={hangupSound} className="voice-hangup-sound" src="/davo-hangup.wav" preload="auto" aria-hidden="true" />
      <footer>
        {voice.state === 'idle' || voice.state === 'error'
          ? <button type="button" className="voice-start" onClick={() => void voice.start()}>Call Davo</button>
          : <div className="voice-call-actions"><button type="button" className="voice-mute" aria-pressed={voice.muted} disabled={voice.state === 'connecting'} onClick={voice.toggleMute}>{voice.muted ? 'Unmute' : 'Mute'}</button><button type="button" className="voice-stop" disabled={voice.state === 'connecting'} onClick={voice.stop}>{voice.state === 'connecting' ? 'Calling...' : 'Hang up'}</button></div>}
        <small>Hanging up does not cancel agent work.</small>
      </footer>
    </div>
  </div>;
}
