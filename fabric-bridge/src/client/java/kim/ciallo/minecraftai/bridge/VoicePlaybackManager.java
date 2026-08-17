package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonObject;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.Queue;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.LockSupport;
import java.util.function.Consumer;

/**
  * 将合成的 PCM 送入已认证的 Simple Voice Chat 客户端连接。
  * 该集成有意使用反射进行内部数据包传输，从而使桥接层无需再分发专有运行时
  * Mod JAR 即可保持可构建。
  */
final class VoicePlaybackManager {
    private static final int VOICECHAT_SAMPLE_RATE = 48_000;
    private static final int FRAME_SAMPLES = 960;
    private static final int MAX_SESSION_BYTES = 6 * 1024 * 1024;
    private static final int MAX_QUEUE = 3;
    private static final long FRAME_NANOS = 20_000_000L;

    record Result(boolean ok, String detail) {}
    record Status(boolean ok, String detail) {}
    private record Audio(short[] samples, String sessionId) {}

    private final Consumer<Status> statusSink;
    private final Queue<Audio> queue = new ArrayDeque<>();
    private final AtomicLong fallbackSequence = new AtomicLong();
    private ByteArrayOutputStream incoming;
    private String incomingSession = "";
    private int incomingSampleRate;
    private int incomingExpectedBytes;
    private int incomingSequence;
    private Thread worker;
    private volatile boolean cancelled;

    VoicePlaybackManager(Consumer<Status> statusSink) {
        this.statusSink = statusSink;
    }

    synchronized Result handle(JsonObject action) {
        return switch (string(action, "type")) {
            case "voice_playback_begin" -> begin(action);
            case "voice_playback_chunk" -> chunk(action);
            case "voice_playback_end" -> end(action);
            default -> new Result(false, "unsupported_voice_action");
        };
    }

    synchronized void cancel(String reason) {
        cancelled = true;
        queue.clear();
        resetIncoming();
        Thread current = worker;
        if (current != null) current.interrupt();
        statusSink.accept(new Status(false, "voice_cancelled: " + reason));
    }

    private Result begin(JsonObject action) {
        String sessionId = string(action, "sessionId");
        int sampleRate = integer(action, "sampleRate", 0);
        int expectedBytes = integer(action, "expectedBytes", -1);
        if (sessionId.isBlank() || sessionId.length() > 80) return new Result(false, "invalid_voice_session_id");
        if (sampleRate < 8_000 || sampleRate > 96_000) return new Result(false, "invalid_voice_sample_rate");
        if (expectedBytes <= 0 || expectedBytes > MAX_SESSION_BYTES || (expectedBytes & 1) != 0) return new Result(false, "invalid_voice_byte_count");
        if (incoming != null) return new Result(false, "voice_upload_already_active");
        if (queue.size() >= MAX_QUEUE) return new Result(false, "voice_playback_queue_full");
        incoming = new ByteArrayOutputStream(Math.min(expectedBytes, MAX_SESSION_BYTES));
        incomingSession = sessionId;
        incomingSampleRate = sampleRate;
        incomingExpectedBytes = expectedBytes;
        incomingSequence = 0;
        return new Result(true, "voice_upload_started");
    }

    private Result chunk(JsonObject action) {
        if (incoming == null) return new Result(false, "voice_upload_not_started");
        if (!incomingSession.equals(string(action, "sessionId"))) return new Result(false, "voice_session_mismatch");
        int sequence = integer(action, "sequence", -1);
        if (sequence != incomingSequence) return new Result(false, "voice_chunk_out_of_order; expected=" + incomingSequence);
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(string(action, "data"));
        } catch (IllegalArgumentException error) {
            resetIncoming();
            return new Result(false, "invalid_voice_base64");
        }
        if (decoded.length == 0 || incoming.size() + decoded.length > MAX_SESSION_BYTES || incoming.size() + decoded.length > incomingExpectedBytes) {
            resetIncoming();
            return new Result(false, "voice_payload_too_large");
        }
        incoming.writeBytes(decoded);
        incomingSequence++;
        return new Result(true, "voice_chunk_accepted");
    }

    private Result end(JsonObject action) {
        if (incoming == null) return new Result(false, "voice_upload_not_started");
        if (!incomingSession.equals(string(action, "sessionId"))) return new Result(false, "voice_session_mismatch");
        if (incoming.size() != incomingExpectedBytes) {
            int received = incoming.size();
            int expected = incomingExpectedBytes;
            resetIncoming();
            return new Result(false, "voice_payload_incomplete; expected=" + expected + "; received=" + received);
        }
        try {
            requireVoicechatConnection();
            short[] samples = resample(decodePcm(incoming.toByteArray()), incomingSampleRate, VOICECHAT_SAMPLE_RATE);
            queue.add(new Audio(samples, incomingSession));
            resetIncoming();
            startWorker();
            return new Result(true, "voice_playback_queued");
        } catch (Exception error) {
            resetIncoming();
            return new Result(false, "simple_voice_chat_unavailable: " + safe(error));
        }
    }

    private synchronized void startWorker() {
        if (worker != null && worker.isAlive()) return;
        cancelled = false;
        worker = Thread.ofPlatform().daemon(true).name("minecraft-ai-voice-playback").start(this::playLoop);
    }

    private void playLoop() {
        while (!cancelled) {
            Audio audio;
            synchronized (this) { audio = queue.poll(); }
            if (audio == null) return;
            try {
                play(audio.samples());
                statusSink.accept(new Status(true, "voice_playback_completed; session=" + audio.sessionId()));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception error) {
                statusSink.accept(new Status(false, "voice_playback_failed: " + safe(error)));
            }
        }
    }

    private void play(short[] samples) throws Exception {
        RuntimeConnection runtime = requireVoicechatConnection();
        long nextFrame = System.nanoTime();
        boolean microphoneLocked = false;
        try {
            if (runtime.micThread() != null) {
                runtime.setMicrophoneLocked().invoke(runtime.micThread(), true);
                microphoneLocked = true;
            }
            for (int offset = 0; offset < samples.length && !cancelled; offset += FRAME_SAMPLES) {
                short[] frame = new short[FRAME_SAMPLES];
                System.arraycopy(samples, offset, frame, 0, Math.min(FRAME_SAMPLES, samples.length - offset));
                if (runtime.micThread() != null) {
                    runtime.sendAudioPacket().invoke(runtime.micThread(), frame, false);
                } else {
                    sendFallbackFrame(runtime, frame, false);
                }
                nextFrame += FRAME_NANOS;
                long remaining = nextFrame - System.nanoTime();
                if (remaining > 0L) LockSupport.parkNanos(remaining);
                if (Thread.interrupted()) throw new InterruptedException();
            }
            if (runtime.micThread() != null) runtime.sendStopPacket().invoke(runtime.micThread());
            else sendFallbackPacket(runtime, new byte[0], false);
        } finally {
            if (runtime.encoder() != null) {
                try { runtime.encoderReset().invoke(runtime.encoder()); } catch (Exception ignored) {}
                try { runtime.encoderClose().invoke(runtime.encoder()); } catch (Exception ignored) {}
            }
            if (microphoneLocked) {
                try { runtime.setMicrophoneLocked().invoke(runtime.micThread(), false); } catch (Exception ignored) {}
            }
        }
    }

    private void sendFallbackFrame(RuntimeConnection runtime, short[] frame, boolean whispering) throws Exception {
        byte[] opus = (byte[]) runtime.encoderEncode().invoke(runtime.encoder(), (Object) frame);
        sendFallbackPacket(runtime, opus, whispering);
    }

    private void sendFallbackPacket(RuntimeConnection runtime, byte[] opus, boolean whispering) throws Exception {
        Object microphonePacket = runtime.micPacketConstructor().newInstance(opus, whispering, fallbackSequence.getAndIncrement());
        Object networkMessage = runtime.networkMessageConstructor().newInstance(microphonePacket);
        Object sent = runtime.sendToServer().invoke(runtime.connection(), networkMessage);
        if (sent instanceof Boolean accepted && !accepted) throw new IllegalStateException("voice_packet_rejected");
    }

    private RuntimeConnection requireVoicechatConnection() throws Exception {
        Class<?> clientManagerClass = Class.forName("de.maxhenkel.voicechat.voice.client.ClientManager");
        Object client = clientManagerClass.getMethod("getClient").invoke(null);
        if (client == null) throw new IllegalStateException("voicechat_client_not_initialized");
        Object connection = client.getClass().getMethod("getConnection").invoke(client);
        if (connection == null) throw new IllegalStateException("voicechat_connection_missing");
        Object initialized = connection.getClass().getMethod("isInitialized").invoke(connection);
        if (!(initialized instanceof Boolean ready) || !ready) throw new IllegalStateException("voicechat_udp_not_authenticated");

        Object micThread = client.getClass().getMethod("getMicThread").invoke(client);
        if (micThread != null) {
            Method sendAudioPacket = micThread.getClass().getDeclaredMethod("sendAudioPacket", short[].class, boolean.class);
            Method sendStopPacket = micThread.getClass().getDeclaredMethod("sendStopPacket");
            sendAudioPacket.setAccessible(true);
            sendStopPacket.setAccessible(true);
            return new RuntimeConnection(connection, micThread, null, sendAudioPacket, sendStopPacket,
                micThread.getClass().getMethod("setMicrophoneLocked", boolean.class), null, null, null, null, null, null);
        }

        Class<?> apiImpl = Class.forName("de.maxhenkel.voicechat.plugins.impl.VoicechatClientApiImpl");
        Object api = apiImpl.getMethod("instance").invoke(null);
        Object encoder = api.getClass().getMethod("createEncoder").invoke(api);
        Method encoderEncode = encoder.getClass().getMethod("encode", short[].class);
        Method encoderReset = encoder.getClass().getMethod("resetState");
        Method encoderClose = encoder.getClass().getMethod("close");
        Class<?> packetInterface = Class.forName("de.maxhenkel.voicechat.voice.common.Packet");
        Class<?> microphonePacketClass = Class.forName("de.maxhenkel.voicechat.voice.common.MicPacket");
        Class<?> networkMessageClass = Class.forName("de.maxhenkel.voicechat.voice.common.NetworkMessage");
        Constructor<?> microphonePacketConstructor = microphonePacketClass.getConstructor(byte[].class, boolean.class, long.class);
        Constructor<?> networkMessageConstructor = networkMessageClass.getConstructor(packetInterface);
        Method sendToServer = connection.getClass().getMethod("sendToServer", networkMessageClass);
        return new RuntimeConnection(connection, null, encoder, null, null, null, encoderEncode, encoderReset, encoderClose,
            microphonePacketConstructor, networkMessageConstructor, sendToServer);
    }

    private record RuntimeConnection(
        Object connection, Object micThread, Object encoder, Method sendAudioPacket, Method sendStopPacket,
        Method setMicrophoneLocked, Method encoderEncode, Method encoderReset, Method encoderClose,
        Constructor<?> micPacketConstructor, Constructor<?> networkMessageConstructor, Method sendToServer
    ) {}

    private static short[] decodePcm(byte[] bytes) {
        short[] samples = new short[bytes.length / 2];
        for (int index = 0; index < samples.length; index++) {
            int offset = index * 2;
            samples[index] = (short) ((bytes[offset] & 0xFF) | (bytes[offset + 1] << 8));
        }
        return samples;
    }

    static short[] resample(short[] input, int sourceRate, int targetRate) {
        if (input.length == 0 || sourceRate == targetRate) return input.clone();
        int outputLength = Math.max(1, (int) Math.round(input.length * (double) targetRate / sourceRate));
        short[] output = new short[outputLength];
        double scale = (double) sourceRate / targetRate;
        for (int index = 0; index < outputLength; index++) {
            double source = index * scale;
            int left = Math.min(input.length - 1, (int) source);
            int right = Math.min(input.length - 1, left + 1);
            double fraction = source - left;
            output[index] = (short) Math.round(input[left] + (input[right] - input[left]) * fraction);
        }
        return output;
    }

    private void resetIncoming() {
        incoming = null;
        incomingSession = "";
        incomingSampleRate = 0;
        incomingExpectedBytes = 0;
        incomingSequence = 0;
    }

    private static String string(JsonObject value, String key) {
        return value.has(key) && value.get(key).isJsonPrimitive() ? value.get(key).getAsString() : "";
    }

    private static int integer(JsonObject value, String key, int fallback) {
        try { return value.has(key) ? value.get(key).getAsInt() : fallback; }
        catch (Exception ignored) { return fallback; }
    }

    private static String safe(Throwable error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();
        String message = cause.getMessage();
        return cause.getClass().getSimpleName() + (message == null || message.isBlank() ? "" : ": " + message.replace('\n', ' ').replace('\r', ' '));
    }
}
