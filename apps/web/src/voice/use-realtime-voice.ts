import { useCallback, useEffect, useRef, useState } from 'react';

type Request = (url: string, init?: RequestInit) => Promise<Response>;
type VoiceState = 'idle' | 'connecting' | 'connected' | 'error';
type TranscriptEntry = { id: string; role: 'user' | 'assistant' | 'tool'; text: string };
type RealtimeCredential = { ok: true; clientSecret: { value: string }; model: string };
type VoiceTarget = { worktreeId?: string; worktreeLabel?: string; agentId?: string };
type WorktreeSelection = { worktreeId: string; worktreeLabel: string };
type SelectWorktree = (worktreeId: string) => WorktreeSelection | undefined;

// measure one normalized audio amplitude
function audioLevel(analyser: AnalyserNode | undefined): number {
  if (analyser === undefined) return 0;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  // collect the waveform energy
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 5);
}

// recognize direct call-ending requests
function isHangupRequest(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return /^(?:davo\s+)?(?:(?:can|could|would|will) you\s+|please\s+)?(?:hang up|end (?:the )?call)(?:\s+(?:please|davo|mate|now))*$/u.test(normalized);
}

// recognize reply-free speech interruptions
function isSilentInterruption(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return /^(?:davo\s+)?(?:please\s+)?(?:stop|stop talking|shut up|nope|nah|enough|that s enough|quiet|cut it out)(?:\s+(?:please|davo|mate|now))*$/u.test(normalized);
}

// read one bounded worktree tool argument
function worktreeIdFromArguments(value: unknown): string | undefined {
  // require serialized function arguments
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { return undefined; }
  // require one canonical identifier
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const worktreeId = (parsed as { worktree_id?: unknown }).worktree_id;
  return typeof worktreeId === 'string' && worktreeId.length > 0 && worktreeId.length <= 256 && !worktreeId.includes('\0') ? worktreeId : undefined;
}

export type RealtimeVoice = {
  state: VoiceState;
  error?: string;
  transcript: TranscriptEntry[];
  toolStatus?: string;
  inputLevel: number;
  outputLevel: number;
  muted: boolean;
  endedIntentionally: boolean;
  start: () => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
};

// manage one browser WebRTC Realtime session
export function useRealtimeVoice(request: Request, target: VoiceTarget, onSelectWorktree?: SelectWorktree): RealtimeVoice {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string>();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [toolStatus, setToolStatus] = useState<string>();
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [endedIntentionally, setEndedIntentionally] = useState(false);
  const peer = useRef<RTCPeerConnection | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  const channel = useRef<RTCDataChannel | undefined>(undefined);
  const assistantDraft = useRef('');
  const greeted = useRef(false);
  const hangupPending = useRef(false);
  const attempt = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const voiceSession = useRef<string | undefined>(undefined);
  const heartbeat = useRef<number | undefined>(undefined);
  const meterContext = useRef<AudioContext | undefined>(undefined);
  const inputSource = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const outputSource = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const inputAnalyser = useRef<AnalyserNode | undefined>(undefined);
  const outputAnalyser = useRef<AnalyserNode | undefined>(undefined);
  const meterFrame = useRef<number | undefined>(undefined);
  const inputSpeaking = useRef(false);
  const outputSpeaking = useRef(false);
  const mutedRef = useRef(false);
  const toolsReady = useRef(false);
  const silentInterruptionUntil = useRef(0);
  const silentResponseStarted = useRef(false);
  const selectWorktree = useRef(onSelectWorktree);
  const activeWorktreeLabel = useRef(target.worktreeLabel ?? target.worktreeId);
  selectWorktree.current = onSelectWorktree;
  activeWorktreeLabel.current = target.worktreeLabel ?? target.worktreeId;

  // stop the shared audio meter
  const stopMeter = useCallback(() => {
    if (meterFrame.current !== undefined) window.cancelAnimationFrame(meterFrame.current);
    meterFrame.current = undefined;
    inputSource.current?.disconnect();
    outputSource.current?.disconnect();
    inputSource.current = undefined;
    outputSource.current = undefined;
    inputAnalyser.current = undefined;
    outputAnalyser.current = undefined;
    inputSpeaking.current = false;
    outputSpeaking.current = false;
    const context = meterContext.current;
    meterContext.current = undefined;
    if (context !== undefined) void context.close().catch(() => undefined);
    setInputLevel(0);
    setOutputLevel(0);
  }, []);

  // keep both directional levels current
  const startMeterLoop = useCallback(() => {
    // retain the existing animation loop
    if (meterFrame.current !== undefined) return;
    let previousUpdate = 0;
    // sample without rerendering faster than twenty frames per second
    const update = (time: number) => {
      if (time - previousUpdate >= 50) {
        previousUpdate = time;
        setInputLevel(Math.max(audioLevel(inputAnalyser.current), inputSpeaking.current ? .18 : 0));
        setOutputLevel(Math.max(audioLevel(outputAnalyser.current), outputSpeaking.current ? .22 : 0));
      }
      meterFrame.current = window.requestAnimationFrame(update);
    };
    meterFrame.current = window.requestAnimationFrame(update);
  }, []);

  // attach one media stream to its directional meter
  const connectMeter = useCallback((media: MediaStream, side: 'input' | 'output') => {
    // leave voice functional without Web Audio support
    if (typeof AudioContext === 'undefined') return;
    try {
      const context = meterContext.current ?? new AudioContext();
      meterContext.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = .78;
      const source = context.createMediaStreamSource(media);
      source.connect(analyser);
      // retain the meter for its matching edge
      if (side === 'input') {
        inputSource.current?.disconnect();
        inputSource.current = source;
        inputAnalyser.current = analyser;
      }
      else {
        outputSource.current?.disconnect();
        outputSource.current = source;
        outputAnalyser.current = analyser;
      }
      void context.resume().catch(() => undefined);
      startMeterLoop();
    }
    catch { /* keep voice available */ }
  }, [startMeterLoop]);

  // toggle only the outbound microphone track
  const toggleMute = useCallback(() => {
    setMuted(current => {
      const next = !current;
      mutedRef.current = next;
      stream.current?.getAudioTracks().forEach(track => { track.enabled = toolsReady.current && !next; });
      // clear retained microphone activity while muted
      if (next) {
        inputSpeaking.current = false;
        setInputLevel(0);
      }
      return next;
    });
  }, []);

  // close every media and peer resource
  const stop = useCallback((intentional = false) => {
    attempt.current += 1;
    abort.current?.abort();
    abort.current = undefined;
    const currentVoiceSession = voiceSession.current;
    voiceSession.current = undefined;
    // stop the server mutation gate
    if (currentVoiceSession !== undefined) void request('/api/realtime/session/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceSessionId: currentVoiceSession }), keepalive: true });
    // stop voice lease renewal
    if (heartbeat.current !== undefined) window.clearInterval(heartbeat.current);
    heartbeat.current = undefined;
    const currentChannel = channel.current;
    const currentPeer = peer.current;
    const currentStream = stream.current;
    const currentAudio = audio.current;
    channel.current = undefined;
    peer.current = undefined;
    stream.current = undefined;
    audio.current = undefined;
    currentChannel?.close();
    currentPeer?.close();
    currentStream?.getTracks().forEach(track => track.stop());
    // detach any retained remote audio
    if (currentAudio !== undefined) currentAudio.srcObject = null;
    stopMeter();
    assistantDraft.current = '';
    greeted.current = false;
    hangupPending.current = false;
    mutedRef.current = false;
    toolsReady.current = false;
    silentInterruptionUntil.current = 0;
    silentResponseStarted.current = false;
    setMuted(false);
    setToolStatus(undefined);
    setEndedIntentionally(intentional);
    setState('idle');
  }, [request, stopMeter]);

  // surface one unexpected connection failure
  const failConnection = useCallback((message: string) => {
    stop(false);
    setError(message);
    setState('error');
  }, [stop]);

  // retain bounded transcript entries
  const appendTranscript = useCallback((entry: TranscriptEntry) => {
    setTranscript(current => [...current.slice(-99), entry]);
  }, []);

  // stream one in-progress user transcript
  const updateUser = useCallback((itemId: string, delta: string) => {
    const id = `user-${itemId}`;
    setTranscript(current => {
      const draft = current.find(entry => entry.id === id)?.text ?? '';
      const withoutDraft = current.filter(entry => entry.id !== id);
      return [...withoutDraft.slice(-99), { id, role: 'user', text: `${draft}${delta}` }];
    });
  }, []);

  // finalize one user transcript
  const completeUser = useCallback((itemId: string, text: string) => {
    const id = `user-${itemId}`;
    setTranscript(current => {
      const withoutDraft = current.filter(entry => entry.id !== id);
      // discard empty provider transcripts
      if (text.trim() === '') return withoutDraft;
      return [...withoutDraft.slice(-99), { id, role: 'user', text }];
    });
  }, []);

  // discard one unusable user transcript
  const discardUser = useCallback((itemId: string) => {
    const id = `user-${itemId}`;
    setTranscript(current => current.filter(entry => entry.id !== id));
  }, []);

  // update one in-progress assistant transcript
  const updateAssistant = useCallback((delta: string) => {
    assistantDraft.current += delta;
    const text = assistantDraft.current;
    setTranscript(current => {
      const withoutDraft = current.filter(entry => entry.id !== 'assistant-live');
      return [...withoutDraft.slice(-99), { id: 'assistant-live', role: 'assistant', text }];
    });
  }, []);

  // cancel generation and buffered WebRTC audio
  const silenceDavo = useCallback(() => {
    // require one live provider channel
    if (channel.current?.readyState !== 'open') return;
    channel.current.send(JSON.stringify({ type: 'response.cancel' }));
    channel.current.send(JSON.stringify({ type: 'output_audio_buffer.clear' }));
  }, []);

  // process transcript and MCP lifecycle events
  const handleEvent = useCallback((event: MessageEvent<string>) => {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(event.data) as Record<string, unknown>; }
    catch { return; }
    const type = typeof payload.type === 'string' ? payload.type : '';
    // enable speech only after MCP discovery succeeds
    if (type === 'mcp_list_tools.completed') {
      toolsReady.current = true;
      stream.current?.getAudioTracks().forEach(track => { track.enabled = !mutedRef.current; });
      setToolStatus(undefined);
      setState('connected');
      // answer each call once after tools are ready
      if (!greeted.current && channel.current?.readyState === 'open') {
        greeted.current = true;
        const worktree = activeWorktreeLabel.current ?? 'none selected';
        channel.current.send(JSON.stringify({ type: 'response.create', response: { instructions: `Answer the call with exactly one quick sentence greeting Ansel by name, state that the active worktree is ${worktree}, and invite him to say what needs doing. Sound like Davo with broad Australian tradie banter.`, tools: [] } }));
      }
      return;
    }
    // apply one model-requested canonical worktree selection
    if (type === 'response.function_call_arguments.done' && payload.name === 'select_worktree') {
      const worktreeId = worktreeIdFromArguments(payload.arguments);
      const selection = worktreeId === undefined ? undefined : selectWorktree.current?.(worktreeId);
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      // answer only valid provider function calls
      if (callId !== undefined && channel.current?.readyState === 'open') {
        const output = selection === undefined
          ? { ok: false, error: worktreeId === undefined ? 'invalid worktree selection' : 'worktree is not available in the browser' }
          : { ok: true, worktree_id: selection.worktreeId, worktree_label: selection.worktreeLabel };
        channel.current.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) } }));
        channel.current.send(JSON.stringify({ type: 'response.create' }));
      }
      return;
    }
    // fail instead of exposing a disconnected voice session
    if (type === 'mcp_list_tools.failed') {
      failConnection('Davo could not connect to the Remote Agents tools.');
      return;
    }
    // silently discard speech the provider cannot transcribe
    if (type === 'conversation.item.input_audio_transcription.failed') {
      if (typeof payload.item_id === 'string') discardUser(payload.item_id);
      return;
    }
    // stream partial user transcripts
    if (type === 'conversation.item.input_audio_transcription.delta' && typeof payload.item_id === 'string' && typeof payload.delta === 'string') updateUser(payload.item_id, payload.delta);
    // replace partial text with the final user transcript
    if (type === 'conversation.item.input_audio_transcription.completed' && typeof payload.transcript === 'string') {
      completeUser(typeof payload.item_id === 'string' ? payload.item_id : crypto.randomUUID(), payload.transcript);
      // arm automatic hang-up after Davo's goodbye finishes
      if (isHangupRequest(payload.transcript)) hangupPending.current = true;
      // suppress replies to bare interruptions
      if (isSilentInterruption(payload.transcript)) {
        silentInterruptionUntil.current = Date.now() + 3_000;
        silentResponseStarted.current = false;
        silenceDavo();
      }
    }
    // cancel any response raced by automatic VAD
    if (type === 'response.created' && Date.now() < silentInterruptionUntil.current) {
      silentResponseStarted.current = true;
      silenceDavo();
    }
    // release suppression after the cancelled reply ends
    if (type === 'response.done' && silentResponseStarted.current) {
      silentInterruptionUntil.current = 0;
      silentResponseStarted.current = false;
      return;
    }
    // discard any reply content raced by cancellation
    if ((type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') && Date.now() < silentInterruptionUntil.current) return;
    // provide a provider-backed microphone fallback
    if (type === 'input_audio_buffer.speech_started' && !mutedRef.current) {
      inputSpeaking.current = true;
      setInputLevel(current => Math.max(current, .18));
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      inputSpeaking.current = false;
      if (inputAnalyser.current === undefined) setInputLevel(0);
    }
    // collect streamed assistant transcripts
    if ((type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta') && typeof payload.delta === 'string') updateAssistant(payload.delta);
    // replace the live draft with the final transcript
    if ((type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') && typeof payload.transcript === 'string') {
      assistantDraft.current = '';
      setTranscript(current => [...current.filter(entry => entry.id !== 'assistant-live').slice(-99), { id: crypto.randomUUID(), role: 'assistant', text: payload.transcript as string }]);
    }
    // provide a provider-backed Davo playback fallback
    if (type === 'output_audio_buffer.started') {
      // cut off audio raced by cancellation
      if (Date.now() < silentInterruptionUntil.current) {
        silenceDavo();
        return;
      }
      outputSpeaking.current = true;
      setOutputLevel(current => Math.max(current, .22));
    }
    if (type === 'output_audio_buffer.stopped') {
      outputSpeaking.current = false;
      if (outputAnalyser.current === undefined) setOutputLevel(0);
    }
    // surface remote MCP progress without exposing arguments
    if (type.includes('mcp') || type.includes('tool')) {
      const name = typeof payload.name === 'string' ? payload.name : 'Remote Agents tool';
      let status = 'running';
      // mark completed tools
      if (type.endsWith('.done') || type.endsWith('.completed')) status = 'completed';
      // mark failed tools
      else if (type.endsWith('.failed')) status = 'failed';
      setToolStatus(`${name}: ${status}`);
      // retain completed tool lifecycle entries
      if (status !== 'running') appendTranscript({ id: crypto.randomUUID(), role: 'tool', text: `${name}: ${status}` });
    }
    // ask Davo to speak the completed tool result
    if ((type === 'response.mcp_call.completed' || type === 'response.mcp_call.failed') && channel.current?.readyState === 'open') channel.current.send(JSON.stringify({ type: 'response.create' }));
    // hang up only after WebRTC playback drains
    if (type === 'output_audio_buffer.stopped' && hangupPending.current) {
      stop(true);
      return;
    }
    // report provider session errors
    if (type === 'error') {
      // ignore expected empty-cancel errors
      if (Date.now() < silentInterruptionUntil.current) return;
      setError('Davo reported a session error.');
    }
  }, [appendTranscript, completeUser, discardUser, failConnection, silenceDavo, stop, updateAssistant, updateUser]);

  // establish one direct browser-to-provider WebRTC session
  const start = useCallback(async () => {
    // prevent parallel peer creation
    if (state === 'connecting' || state === 'connected') return;
    const attemptId = ++attempt.current;
    const voiceSessionId = crypto.randomUUID();
    voiceSession.current = voiceSessionId;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    let pendingStream: MediaStream | undefined;
    let pendingPeer: RTCPeerConnection | undefined;
    let pendingAudio: HTMLAudioElement | undefined;
    // detect a closed or superseded attempt
    const stale = () => attempt.current !== attemptId || controller.signal.aborted;
    // release resources owned only by this attempt
    const disposePending = () => {
      pendingPeer?.close();
      pendingStream?.getTracks().forEach(track => track.stop());
      // detach retained remote audio
      if (pendingAudio !== undefined) pendingAudio.srcObject = null;
      // clear shared refs only when they still belong to this attempt
      if (peer.current === pendingPeer) peer.current = undefined;
      if (stream.current === pendingStream) stream.current = undefined;
      if (audio.current === pendingAudio) audio.current = undefined;
    };
    setState('connecting');
    setError(undefined);
    setEndedIntentionally(false);
    setTranscript([]);
    mutedRef.current = false;
    toolsReady.current = false;
    setMuted(false);
    try {
      const credentialResponse = await request('/api/realtime/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(target.worktreeId === undefined ? {} : { worktreeId: target.worktreeId }), ...(target.agentId === undefined ? {} : { agentId: target.agentId }), voiceSessionId }), signal: controller.signal });
      // abandon closed dialogs before requesting microphone access
      if (stale()) return;
      // require one server-minted ephemeral credential
      if (!credentialResponse.ok) throw new Error(credentialResponse.status === 503 ? 'Davo is not configured on this server.' : 'Unable to start Davo.');
      const credential = await credentialResponse.json() as RealtimeCredential;
      // abandon closed dialogs after response parsing
      if (stale()) return;
      // validate the browser-safe credential envelope
      if (credential.ok !== true || typeof credential.clientSecret?.value !== 'string' || typeof credential.model !== 'string') throw new Error('The server returned an invalid Realtime session.');
      // keep mutation access bound to this live voice session
      heartbeat.current = window.setInterval(() => {
        void request('/api/realtime/session/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceSessionId }) }).then(response => {
          const accessRevoked = [400, 401, 403, 404, 409, 423].includes(response.status);
          // stop only after an authoritative lease rejection
          if (accessRevoked && voiceSession.current === voiceSessionId) failConnection('Davo lost remote control access. Call again to reconnect.');
        });
      }, 10_000);
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      pendingStream = media;
      connectMeter(media, 'input');
      // suppress speech until remote tools are ready
      media.getAudioTracks().forEach(track => { track.enabled = false; });
      // stop media acquired after cancellation
      if (stale()) { disposePending(); return; }
      const connection = new RTCPeerConnection();
      const output = new Audio();
      pendingPeer = connection;
      pendingAudio = output;
      output.autoplay = true;
      // attach remote audio as soon as it arrives
      connection.ontrack = remote => {
        const remoteStream = remote.streams[0] ?? new MediaStream([remote.track]);
        output.srcObject = remoteStream;
        connectMeter(remoteStream, 'output');
      };
      media.getTracks().forEach(track => connection.addTrack(track, media));
      const data = connection.createDataChannel('oai-events');
      data.addEventListener('message', handleEvent);
      data.addEventListener('open', () => { if (!stale()) setToolStatus('Loading Davo tools…'); });
      data.addEventListener('close', () => {
        // keep unexpected disconnects visible
        if (!stale()) failConnection('Davo disconnected. Call again to reconnect.');
      });
      // release the microphone after transport failure
      connection.addEventListener('connectionstatechange', () => {
        // stop only terminal transport states
        if (!stale() && (connection.connectionState === 'failed' || connection.connectionState === 'closed')) failConnection('Davo disconnected. Call again to reconnect.');
      });
      peer.current = connection;
      stream.current = media;
      audio.current = output;
      channel.current = data;
      const offer = await connection.createOffer();
      // stop before publishing a stale offer
      if (stale()) { disposePending(); return; }
      await connection.setLocalDescription(offer);
      // stop after local description work
      if (stale()) { disposePending(); return; }
      const answerResponse = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(credential.model)}`, { method: 'POST', headers: { authorization: `Bearer ${credential.clientSecret.value}`, 'content-type': 'application/sdp' }, body: offer.sdp, signal: controller.signal });
      // stop after provider negotiation
      if (stale()) { disposePending(); return; }
      // reject provider negotiation failures
      if (!answerResponse.ok) throw new Error('The Realtime connection was rejected.');
      const answer = await answerResponse.text();
      // stop before applying a stale answer
      if (stale()) { disposePending(); return; }
      await connection.setRemoteDescription({ type: 'answer', sdp: answer });
      // stop after asynchronous remote setup
      if (stale()) { disposePending(); return; }
    } catch (cause) {
      // ignore deliberate cancellation while cleaning this attempt
      if (stale()) { disposePending(); return; }
      failConnection(cause instanceof Error ? cause.message : 'Unable to start Davo.');
    }
  }, [connectMeter, failConnection, handleEvent, request, state, stop, target.agentId, target.worktreeId]);

  // stop media and mutation access on close or navigation
  useEffect(() => {
    const pageHide = () => stop(false);
    window.addEventListener('pagehide', pageHide);
    return () => {
      window.removeEventListener('pagehide', pageHide);
      stop(false);
    };
  }, [stop]);
  const hangup = useCallback(() => stop(true), [stop]);
  return { state, ...(error === undefined ? {} : { error }), transcript, ...(toolStatus === undefined ? {} : { toolStatus }), inputLevel, outputLevel, muted, endedIntentionally, start, stop: hangup, toggleMute };
}
