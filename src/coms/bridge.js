import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import * as coms from './client.js';
import { CHANNELS, FRAME_SAMPLES, FRAME_VALUES, FrameClock, PcmMixer, SAMPLE_RATE } from './mixer.js';

/**
 * One Discord voice channel ↔ one coms channel.
 *
 *  coms → Discord: every remote audio track in the LiveKit room is mixed and
 *    played into the voice channel (always on — Discord can always listen).
 *  Discord → coms: people speaking in the voice channel are decoded, mixed
 *    and published as one LiveKit audio track — only while Talk is on, so
 *    Discord chatter can't leak onto coms.
 *
 * Neither side hears itself: the bot's own Discord audio isn't received, and
 * the LiveKit room never plays our own track back (mix-minus by identity).
 *
 * Emits 'update' when something shown on the control panel changes, and
 * 'closed' (with a reason) when it shuts down for good.
 */

const SPEAKER_SILENCE_MS = 1000; // a Discord speaker's stream ends after this much silence
const LIVEKIT_RECONNECT_MS = [2000, 5000, 10000, 30000];
// Keep LiveKit's outgoing queue short so talk latency stays low.
const MAX_QUEUED_MS = 200;

export class ComsBridge extends EventEmitter {
  constructor({ guild, voiceChannel, comsChannel }) {
    super();
    this.guild = guild;
    this.voiceChannel = voiceChannel;
    this.comsChannel = comsChannel; // { id, name }
    this.talk = false;
    this.discordReady = false;
    this.comsReady = false;
    this.closed = false;
    this.startedAt = Date.now();

    this.fromComs = new PcmMixer(); // remote LiveKit tracks → Discord
    this.fromDiscord = new PcmMixer(); // Discord speakers → coms
    this.speakers = new Map(); // Discord userId -> decoder stream
    this.room = null;
    this.source = null;
    this.captureChain = Promise.resolve();
  }

  /** Who's on the coms channel right now (display names), for the panel. */
  comsParticipants() {
    if (!this.room) return [];
    return [...this.room.remoteParticipants.values()].map((p) => p.name || p.identity);
  }

  async start() {
    await this.connectComs();
    this.connectDiscord();
    this.clock = new FrameClock(() => this.tick());
    this.clock.start();
  }

  // ── Discord side ─────────────────────────────────────────────────────────

  connectDiscord() {
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false, // must hear the channel to send it to coms
      selfMute: false,
    });

    this.output = new Readable({ read() {} });
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.playOutput();
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (!this.closed) this.playOutput(); // the stream should never end; if it does, start a fresh one
    });
    this.player.on('error', (err) => console.error('[coms] Discord player error:', err.message));
    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Ready, () => {
      this.discordReady = true;
      this.emit('update');
    });
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      this.discordReady = false;
      this.emit('update');
      try {
        // Moved channel / brief network blip: Discord reconnects by itself within a few seconds.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.close('Disconnected from the Discord voice channel');
      }
    });

    this.connection.receiver.speaking.on('start', (userId) => this.onSpeaking(userId));
  }

  playOutput() {
    this.output?.destroy();
    this.output = new Readable({ read() {} });
    this.player.play(createAudioResource(this.output, { inputType: StreamType.Raw }));
  }

  onSpeaking(userId) {
    if (!this.talk || this.speakers.has(userId)) return;
    const member = this.guild.members.cache.get(userId);
    if (member?.user.bot) return;

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SPEAKER_SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: FRAME_SAMPLES });
    const pcm = opus.pipe(decoder);
    this.speakers.set(userId, pcm);
    pcm.on('data', (chunk) => this.fromDiscord.push(userId, chunk));
    const done = () => {
      this.speakers.delete(userId);
      this.fromDiscord.remove(userId);
    };
    pcm.once('end', done);
    pcm.once('close', done);
    pcm.once('error', (err) => {
      console.error('[coms] Discord decode error:', err.message);
      done();
    });
  }

  // ── coms (LiveKit) side ──────────────────────────────────────────────────

  async connectComs() {
    const cfg = await coms.getConfig({ fresh: true });
    const token = cfg.channelTokens?.[this.comsChannel.id];
    if (!cfg.livekitUrl || !token) throw new Error(`The bot's bridge key has no access to coms channel "${this.comsChannel.name}".`);

    const room = new Room();
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      this.pumpRemoteTrack(track, `${participant.identity}:${publication.sid}`);
    });
    room.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
      this.fromComs.remove(`${participant.identity}:${publication.sid}`);
    });
    room.on(RoomEvent.ParticipantConnected, () => this.emit('update'));
    room.on(RoomEvent.ParticipantDisconnected, () => this.emit('update'));
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room || this.closed) return;
      this.comsReady = false;
      this.fromComs.clear();
      this.emit('update');
      this.reconnectComs(0);
    });

    await room.connect(cfg.livekitUrl, token, { autoSubscribe: true, dynacast: false });

    const source = new AudioSource(SAMPLE_RATE, CHANNELS);
    const track = LocalAudioTrack.createAudioTrack('discord', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant.publishTrack(track, options);

    this.room = room;
    this.source = source;
    this.comsReady = true;
    this.emit('update');
  }

  async reconnectComs(attempt) {
    if (this.closed) return;
    const delay = LIVEKIT_RECONNECT_MS[Math.min(attempt, LIVEKIT_RECONNECT_MS.length - 1)];
    await new Promise((r) => setTimeout(r, delay));
    if (this.closed) return;
    try {
      await this.connectComs();
    } catch (err) {
      console.error(`[coms] reconnect to coms failed (attempt ${attempt + 1}):`, err.message);
      this.reconnectComs(attempt + 1);
    }
  }

  /** Reads one remote track as 48 kHz stereo and feeds it to the coms → Discord mix. */
  async pumpRemoteTrack(track, key) {
    const stream = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: CHANNELS });
    try {
      for await (const frame of stream) {
        if (this.closed) break;
        this.fromComs.push(key, frame.data);
      }
    } catch (err) {
      if (!this.closed) console.error('[coms] remote track read error:', err.message);
    } finally {
      this.fromComs.remove(key);
    }
  }

  // ── every 20 ms ──────────────────────────────────────────────────────────

  tick() {
    // coms → Discord: always. Silence when nobody's talking keeps Discord's player fed.
    if (this.output && this.output.readableLength < FRAME_VALUES * 2 * 10) {
      const mixed = this.fromComs.readFrame() ?? new Int16Array(FRAME_VALUES);
      this.output.push(Buffer.from(mixed.buffer, mixed.byteOffset, mixed.byteLength));
    }

    // Discord → coms: only while Talk is on.
    if (this.talk && this.source && this.comsReady) {
      const mixed = this.fromDiscord.readFrame() ?? new Int16Array(FRAME_VALUES);
      if (this.source.queuedDuration <= MAX_QUEUED_MS) {
        const frame = new AudioFrame(mixed, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES);
        this.captureChain = this.captureChain.then(() => this.source.captureFrame(frame)).catch(() => {});
      }
    }
  }

  // ── controls ─────────────────────────────────────────────────────────────

  /**
   * Moves the bridge to another coms channel, keeping the Discord side
   * connected. Talk is turned off first so nobody is suddenly live on the new
   * channel. If the new channel won't connect, goes back to the old one
   * (and closes only if that fails too). Throws the new channel's error.
   */
  async switchComs(comsChannel) {
    if (this.switching) throw new Error('Already switching coms channels — try again in a moment.');
    this.switching = true;
    const previous = this.comsChannel;
    try {
      this.setTalk(false);
      await this.leaveComs();
      this.comsChannel = comsChannel;
      this.emit('update');
      try {
        await this.connectComs();
      } catch (err) {
        this.comsChannel = previous;
        try {
          await this.connectComs();
        } catch {
          this.close(`Couldn't reconnect to coms after a failed switch: ${err.message}`);
        }
        throw err;
      }
    } finally {
      this.switching = false;
      this.emit('update');
    }
  }

  /** Disconnects from the current coms room without closing the bridge (its Disconnected event is ignored). */
  async leaveComs() {
    const room = this.room;
    this.room = null;
    this.source = null;
    this.comsReady = false;
    this.fromComs.clear();
    await room?.disconnect().catch(() => {});
  }

  setTalk(on) {
    this.talk = on;
    if (!on) {
      for (const pcm of this.speakers.values()) pcm.destroy();
      this.speakers.clear();
      this.fromDiscord.clear();
      this.source?.clearQueue();
    }
    this.emit('update');
  }

  async close(reason = 'Bridge closed') {
    if (this.closed) return;
    this.closed = true;
    this.clock?.stop();
    for (const pcm of this.speakers.values()) pcm.destroy();
    this.speakers.clear();
    this.output?.destroy();
    this.player?.stop(true);
    try {
      this.connection?.destroy();
    } catch {
      // already destroyed
    }
    await this.room?.disconnect().catch(() => {});
    this.emit('closed', reason);
  }
}
