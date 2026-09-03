import { useCallback, useEffect, useRef, useState } from 'react';

type Request = (url: string, init?: RequestInit) => Promise<Response>;
type VoiceState = 'idle' | 'connecting' | 'connected' | 'error';
export type ToolState = 'running' | 'completed' | 'incomplete' | 'failed';
export type SpeechTranscriptEntry = { id: string; role: 'user' | 'assistant'; text: string; timestamp: number };
export type ToolTranscriptEntry = { id: string; role: 'tool'; text: string; timestamp: number; name: string; status: ToolState; request?: string; result?: string; error?: string };
export type TranscriptEntry = SpeechTranscriptEntry | ToolTranscriptEntry;
type ToolTranscriptPatch = Partial<Pick<ToolTranscriptEntry, 'name' | 'status' | 'request' | 'result' | 'error'>>;
type RealtimeCredential = { ok: true; clientSecret: { value: string }; model: string };
type VoiceTarget = { worktreeId?: string; worktreeLabel?: string; agentId?: string };
type WorktreeSelection = { worktreeId: string; worktreeLabel: string };
type SelectWorktree = (worktreeId: string) => WorktreeSelection | undefined;
const toolDetailMaxChars = 8 * 1_024;
const toolHistoryMaxChars = 256 * 1_024;

// narrow one provider object
function recordFrom(value: unknown): Record<string, unknown> | undefined {
  // require a non-array object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

// retain one searchable provider detail
function detailFrom(value: unknown): string | undefined {
  // preserve non-empty strings directly
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  // skip absent values
  if (value === undefined || value === null) return undefined;
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

// bound one retained provider detail
function boundedToolDetail(value: string | undefined): string | undefined {
  // preserve absent and already compact details
  if (value === undefined || value.length <= toolDetailMaxChars) return value;
  const suffix = '\n… [truncated]';
  return `${value.slice(0, toolDetailMaxChars - suffix.length)}${suffix}`;
}

// measure retained tool detail
function toolEntryChars(entry: ToolTranscriptEntry): number {
  return entry.name.length + entry.text.length + (entry.request?.length ?? 0) + (entry.result?.length ?? 0) + (entry.error?.length ?? 0);
}

// keep recent tool history within one character budget
function boundedToolHistory(entries: TranscriptEntry[]): TranscriptEntry[] {
  const retained: TranscriptEntry[] = [];
  let toolChars = 0;
  // prefer the newest structured tool entries
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // retain speech outside the tool-detail budget
    if (entry.role !== 'tool') {
      retained.push(entry);
      continue;
    }
    const size = toolEntryChars(entry);
    // discard only older tool rows beyond the budget
    if (toolChars + size > toolHistoryMaxChars) continue;
    toolChars += size;
    retained.push(entry);
  }
  return retained.reverse();
}

// read one provider string field
function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

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

// normalize one spoken control phrase
function normalizedVoiceCommand(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

// replace the configured assistant name in spoken controls
function assistantVoiceCommand(text: string, assistantName: string): string {
  const command = normalizedVoiceCommand(text);
  const name = normalizedVoiceCommand(assistantName);
  // retain commands when the configured name has no searchable tokens
  if (name === '') return command;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return command.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'gu'), '$1assistant');
}

// recognize direct call-ending requests
function isHangupRequest(text: string, assistantName: string): boolean {
  return /^(?:assistant\s+)?(?:(?:can|could|would|will) you\s+|please\s+)?(?:hang up|end (?:the )?call)(?:\s+(?:please|assistant|mate|now))*$/u.test(assistantVoiceCommand(text, assistantName));
}

// recognize reply-free speech interruptions
function isSilentInterruption(text: string, assistantName: string): boolean {
  return /^(?:assistant\s+)?(?:please\s+)?(?:stop|stop talking|shut up|nope|nah|enough|that s enough|quiet|cut it out)(?:\s+(?:please|assistant|mate|now))*$/u.test(assistantVoiceCommand(text, assistantName));
}

// recognize the exact mute control command
function isMuteRequest(text: string, assistantName: string): boolean {
  return /^(?:assistant\s+)?(?:please\s+)?mute(?:\s+(?:please|assistant|mate|now))*$/u.test(assistantVoiceCommand(text, assistantName));
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
export function useRealtimeVoice(request: Request, target: VoiceTarget, onSelectWorktree: SelectWorktree | undefined, muteCommandActive: boolean, assistantName: string): RealtimeVoice {
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
  const pendingToolNames = useRef(new Map<string, string>());
  const finalizedToolIds = useRef(new Set<string>());
  const silentInterruptionUntil = useRef(0);
  const silentResponseStarted = useRef(false);
  const selectWorktree = useRef(onSelectWorktree);
  const muteCommandActiveRef = useRef(muteCommandActive);
  const activeWorktreeLabel = useRef(target.worktreeLabel ?? target.worktreeId);
  selectWorktree.current = onSelectWorktree;
  muteCommandActiveRef.current = muteCommandActive;
  activeWorktreeLabel.current = target.worktreeLabel ?? target.worktreeId;

  // publish the remaining tool batch progress
  const syncToolStatus = useCallback(() => {
    const names = [...pendingToolNames.current.values()];
    const name = names.at(-1);
    setToolStatus(name === undefined ? undefined : `Tool · ${name}`);
  }, []);

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

  // keep spoken mute idempotent under replay
  const mute = useCallback(() => {
    mutedRef.current = true;
    // disable every microphone track
    stream.current?.getAudioTracks().forEach(track => { track.enabled = false; });
    inputSpeaking.current = false;
    setInputLevel(0);
    setMuted(true);
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
    pendingToolNames.current.clear();
    finalizedToolIds.current.clear();
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

  // merge one bounded tool history entry
  const updateToolTranscript = useCallback((id: string, patch: ToolTranscriptPatch) => {
    setTranscript(current => {
      const existing = current.find((entry): entry is ToolTranscriptEntry => entry.id === id && entry.role === 'tool');
      const name = patch.name ?? existing?.name ?? 'Remote Agents tool';
      const status = patch.status ?? existing?.status ?? 'running';
      const requestDetail = boundedToolDetail(patch.request ?? existing?.request);
      const resultDetail = boundedToolDetail(patch.result ?? existing?.result);
      const errorDetail = boundedToolDetail(patch.error ?? existing?.error);
      const entry: ToolTranscriptEntry = {
        id,
        role: 'tool',
        text: `${name}: ${status}`,
        timestamp: existing?.timestamp ?? Date.now(),
        name,
        status,
        ...(requestDetail === undefined ? {} : { request: requestDetail }),
        ...(resultDetail === undefined ? {} : { result: resultDetail }),
        ...(errorDetail === undefined ? {} : { error: errorDetail })
      };
      const withoutEntry = current.filter(candidate => candidate.id !== id);
      return boundedToolHistory([...withoutEntry.slice(-99), entry]);
    });
  }, []);

  // stream one in-progress user transcript
  const updateUser = useCallback((itemId: string, delta: string) => {
    const id = `user-${itemId}`;
    setTranscript(current => {
      const existing = current.find(entry => entry.id === id && entry.role === 'user');
      const draft = existing?.text ?? '';
      const withoutDraft = current.filter(entry => entry.id !== id);
      return [...withoutDraft.slice(-99), { id, role: 'user', text: `${draft}${delta}`, timestamp: existing?.timestamp ?? Date.now() }];
    });
  }, []);

  // finalize one user transcript
  const completeUser = useCallback((itemId: string, text: string) => {
    const id = `user-${itemId}`;
    setTranscript(current => {
      const existing = current.find(entry => entry.id === id && entry.role === 'user');
      const withoutDraft = current.filter(entry => entry.id !== id);
      // discard empty provider transcripts
      if (text.trim() === '') return withoutDraft;
      return [...withoutDraft.slice(-99), { id, role: 'user', text, timestamp: existing?.timestamp ?? Date.now() }];
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
      const existing = current.find(entry => entry.id === 'assistant-live' && entry.role === 'assistant');
      const withoutDraft = current.filter(entry => entry.id !== 'assistant-live');
      return [...withoutDraft.slice(-99), { id: 'assistant-live', role: 'assistant', text, timestamp: existing?.timestamp ?? Date.now() }];
    });
  }, []);

  // cancel generation and buffered WebRTC audio
  const silenceAssistant = useCallback(() => {
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
    const item = recordFrom(payload.item);
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
        channel.current.send(JSON.stringify({ type: 'response.create', response: { instructions: `Answer the call with exactly one quick sentence. Greet the caller using any identity in your configured context, state that the active worktree is ${worktree}, and invite them to say what needs doing.`, tools: [] } }));
      }
      return;
    }
    // apply one model-requested canonical worktree selection
    if (type === 'response.function_call_arguments.done' && payload.name === 'select_worktree') {
      const worktreeId = worktreeIdFromArguments(payload.arguments);
      const selection = worktreeId === undefined ? undefined : selectWorktree.current?.(worktreeId);
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      const requestDetail = detailFrom(payload.arguments);
      const output = selection === undefined
        ? { ok: false, error: worktreeId === undefined ? 'invalid worktree selection' : 'worktree is not available in the browser' }
        : { ok: true, worktree_id: selection.worktreeId, worktree_label: selection.worktreeLabel };
      const toolError = callId === undefined ? 'missing function call identifier' : selection === undefined ? (worktreeId === undefined ? 'invalid worktree selection' : 'worktree is not available in the browser') : undefined;
      updateToolTranscript(`tool-${callId ?? crypto.randomUUID()}`, {
        name: 'select_worktree',
        status: toolError === undefined ? 'completed' : 'failed',
        ...(requestDetail === undefined ? {} : { request: requestDetail }),
        result: JSON.stringify(output),
        ...(toolError === undefined ? {} : { error: toolError })
      });
      // answer only valid provider function calls
      if (callId !== undefined && channel.current?.readyState === 'open') {
        channel.current.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) } }));
        channel.current.send(JSON.stringify({ type: 'response.create' }));
      }
      return;
    }
    // fail instead of exposing a disconnected voice session
    if (type === 'mcp_list_tools.failed') {
      failConnection(`${assistantName} could not connect to the Remote Agents tools.`);
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
      // mute only while the voice surface is open
      if (muteCommandActiveRef.current && isMuteRequest(payload.transcript, assistantName)) mute();
      // arm automatic hang-up after the assistant's goodbye finishes
      if (isHangupRequest(payload.transcript, assistantName)) hangupPending.current = true;
      // suppress replies to bare interruptions
      if (isSilentInterruption(payload.transcript, assistantName)) {
        silentInterruptionUntil.current = Date.now() + 3_000;
        silentResponseStarted.current = false;
        silenceAssistant();
      }
    }
    // cancel any response raced by automatic VAD
    if (type === 'response.created' && Date.now() < silentInterruptionUntil.current) {
      silentResponseStarted.current = true;
      silenceAssistant();
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
      setTranscript(current => {
        const existing = current.find(entry => entry.id === 'assistant-live' && entry.role === 'assistant');
        return [...current.filter(entry => entry.id !== 'assistant-live').slice(-99), { id: crypto.randomUUID(), role: 'assistant', text: payload.transcript as string, timestamp: existing?.timestamp ?? Date.now() }];
      });
    }
    // provide a provider-backed assistant playback fallback
    if (type === 'output_audio_buffer.started') {
      // cut off audio raced by cancellation
      if (Date.now() < silentInterruptionUntil.current) {
        silenceAssistant();
        return;
      }
      outputSpeaking.current = true;
      setOutputLevel(current => Math.max(current, .22));
    }
    if (type === 'output_audio_buffer.stopped') {
      outputSpeaking.current = false;
      if (outputAnalyser.current === undefined) setOutputLevel(0);
    }
    // merge MCP items carrying request and result detail
    if ((type === 'response.output_item.added' || type === 'response.output_item.done' || type === 'conversation.item.added') && item?.type === 'mcp_call') {
      const itemId = stringFrom(item.id) ?? stringFrom(payload.item_id);
      // ignore lifecycle events that cannot be correlated safely
      if (itemId === undefined) return;
      const name = stringFrom(item.name);
      const requestDetail = detailFrom(item.arguments);
      const resultDetail = detailFrom(item.output);
      const itemError = detailFrom(item.error);
      const terminal = type === 'response.output_item.done';
      const status: ToolState = itemError !== undefined || item.status === 'failed'
        ? 'failed'
        : item.status === 'completed'
          ? 'completed'
          : terminal
            ? 'incomplete'
            : 'running';
      const errorDetail = itemError ?? (status === 'failed' ? 'Tool call failed.' : undefined);
      updateToolTranscript(`tool-${itemId}`, {
        ...(name === undefined ? {} : { name }),
        status,
        ...(requestDetail === undefined ? {} : { request: requestDetail }),
        ...(resultDetail === undefined ? {} : { result: resultDetail }),
        ...(errorDetail === undefined ? {} : { error: errorDetail })
      });
      // track only active correlated tool work
      if (status === 'running') pendingToolNames.current.set(itemId, name ?? pendingToolNames.current.get(itemId) ?? 'Remote Agents');
      else pendingToolNames.current.delete(itemId);
      syncToolStatus();
      return;
    }
    // retain finalized MCP request arguments
    if (type === 'response.mcp_call_arguments.done') {
      const itemId = stringFrom(payload.item_id);
      // ignore lifecycle events that cannot be correlated safely
      if (itemId === undefined) return;
      const name = stringFrom(payload.name);
      const requestDetail = detailFrom(payload.arguments);
      updateToolTranscript(`tool-${itemId}`, { ...(name === undefined ? {} : { name }), status: 'running', ...(requestDetail === undefined ? {} : { request: requestDetail }) });
      pendingToolNames.current.set(itemId, name ?? pendingToolNames.current.get(itemId) ?? 'Remote Agents');
      syncToolStatus();
      return;
    }
    // merge one MCP lifecycle update
    if (type === 'response.mcp_call.in_progress' || type === 'response.mcp_call.completed' || type === 'response.mcp_call.failed') {
      const itemId = stringFrom(payload.item_id);
      // ignore lifecycle events that cannot be correlated safely
      if (itemId === undefined) return;
      const name = stringFrom(payload.name);
      const requestDetail = detailFrom(payload.arguments);
      const resultDetail = detailFrom(payload.output);
      const status: ToolState = type.endsWith('.failed') ? 'failed' : type.endsWith('.completed') ? 'completed' : 'running';
      const errorDetail = detailFrom(payload.error) ?? (status === 'failed' ? 'Tool call failed.' : undefined);
      updateToolTranscript(`tool-${itemId}`, {
        ...(name === undefined ? {} : { name }),
        status,
        ...(requestDetail === undefined ? {} : { request: requestDetail }),
        ...(resultDetail === undefined ? {} : { result: resultDetail }),
        ...(errorDetail === undefined ? {} : { error: errorDetail })
      });
      // retain active calls until the whole batch settles
      if (status === 'running') {
        pendingToolNames.current.set(itemId, name ?? pendingToolNames.current.get(itemId) ?? 'Remote Agents');
        syncToolStatus();
        return;
      }
      pendingToolNames.current.delete(itemId);
      syncToolStatus();
      const duplicateTerminal = finalizedToolIds.current.has(itemId);
      finalizedToolIds.current.add(itemId);
      // ask the assistant to speak once after the complete tool batch
      if (!duplicateTerminal && pendingToolNames.current.size === 0 && channel.current?.readyState === 'open') channel.current.send(JSON.stringify({ type: 'response.create' }));
      return;
    }
    // retain MCP discovery progress without history noise
    if (type === 'mcp_list_tools.in_progress') {
      setToolStatus(`Loading ${assistantName} tools…`);
      return;
    }
    // hang up only after WebRTC playback drains
    if (type === 'output_audio_buffer.stopped' && hangupPending.current) {
      stop(true);
      return;
    }
    // report provider session errors
    if (type === 'error') {
      // ignore expected empty-cancel errors
      if (Date.now() < silentInterruptionUntil.current) return;
      setError(`${assistantName} reported a session error.`);
    }
  }, [assistantName, completeUser, discardUser, failConnection, mute, silenceAssistant, stop, syncToolStatus, updateAssistant, updateToolTranscript, updateUser]);

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
    pendingToolNames.current.clear();
    finalizedToolIds.current.clear();
    setMuted(false);
    try {
      const credentialResponse = await request('/api/realtime/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(target.worktreeId === undefined ? {} : { worktreeId: target.worktreeId }), ...(target.agentId === undefined ? {} : { agentId: target.agentId }), voiceSessionId }), signal: controller.signal });
      // abandon closed dialogs before requesting microphone access
      if (stale()) return;
      // require one server-minted ephemeral credential
      if (!credentialResponse.ok) throw new Error(credentialResponse.status === 503 ? `${assistantName} is not configured on this server.` : `Unable to start ${assistantName}.`);
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
          if (accessRevoked && voiceSession.current === voiceSessionId) failConnection(`${assistantName} lost remote control access. Call again to reconnect.`);
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
      data.addEventListener('open', () => { if (!stale()) setToolStatus(`Loading ${assistantName} tools…`); });
      data.addEventListener('close', () => {
        // keep unexpected disconnects visible
        if (!stale()) failConnection(`${assistantName} disconnected. Call again to reconnect.`);
      });
      // release the microphone after transport failure
      connection.addEventListener('connectionstatechange', () => {
        // stop only terminal transport states
        if (!stale() && (connection.connectionState === 'failed' || connection.connectionState === 'closed')) failConnection(`${assistantName} disconnected. Call again to reconnect.`);
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
      failConnection(cause instanceof Error ? cause.message : `Unable to start ${assistantName}.`);
    }
  }, [assistantName, connectMeter, failConnection, handleEvent, request, state, stop, target.agentId, target.worktreeId]);

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
