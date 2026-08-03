package kim.ciallo.minecraftai.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentLinkedQueue;

final class BridgeConnection implements AutoCloseable {
    private static final Gson GSON = new Gson();
    private final String host;
    private final int port;
    private final ConcurrentLinkedQueue<JsonObject> incoming = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<JsonObject> outgoing = new ConcurrentLinkedQueue<>();
    private volatile boolean running = true;
    private volatile boolean connected;
    private Thread worker;

    BridgeConnection() {
        this.host = System.getenv().getOrDefault("MCAI_BRIDGE_HOST", "127.0.0.1");
        this.port = parsePort(System.getenv("MCAI_BRIDGE_PORT"));
        validateHost();
    }

    void start() {
        worker = Thread.ofPlatform().daemon(true).name("minecraft-ai-local-bridge").start(this::runLoop);
    }

    boolean isConnected() {
        return connected;
    }

    JsonObject poll() {
        return incoming.poll();
    }

    void send(JsonObject message) {
        if (outgoing.size() < 1000) outgoing.add(message);
    }

    private void runLoop() {
        while (running) {
            try (Socket socket = new Socket(host, port)) {
                socket.setSoTimeout(250);
                socket.setTcpNoDelay(true);
                connected = true;
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                     BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8))) {
                    JsonObject hello = new JsonObject();
                    hello.addProperty("type", "hello");
                    hello.addProperty("protocolVersion", 1);
                    hello.addProperty("adapter", "fabric-26.2");
                    write(writer, hello);
                    while (running && !socket.isClosed()) {
                        JsonObject message;
                        while ((message = outgoing.poll()) != null) write(writer, message);
                        try {
                            String line = reader.readLine();
                            if (line == null) break;
                            if (line.length() <= 1_000_000) incoming.add(GSON.fromJson(line, JsonObject.class));
                        } catch (SocketTimeoutException ignored) {
                            // Timeout lets this loop flush outgoing messages and observe shutdown.
                        }
                    }
                }
            } catch (Exception ignored) {
                connected = false;
                sleep(2000);
            } finally {
                connected = false;
            }
        }
    }

    private static void write(BufferedWriter writer, JsonObject message) throws Exception {
        writer.write(GSON.toJson(message));
        writer.newLine();
        writer.flush();
    }

    private void validateHost() {
        if (Boolean.parseBoolean(System.getenv().getOrDefault("MCAI_ALLOW_REMOTE_BRIDGE", "false"))) return;
        try {
            if (!InetAddress.getByName(host).isLoopbackAddress()) throw new IllegalArgumentException("MCAI_BRIDGE_HOST 默认只允许本机回环地址");
        } catch (Exception error) {
            throw new IllegalArgumentException("无效或不安全的 MCAI_BRIDGE_HOST", error);
        }
    }

    private static int parsePort(String raw) {
        if (raw == null || raw.isBlank()) return 8765;
        int value = Integer.parseInt(raw);
        if (value < 1 || value > 65535) throw new IllegalArgumentException("MCAI_BRIDGE_PORT 超出范围");
        return value;
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public void close() {
        running = false;
        if (worker != null) worker.interrupt();
    }
}
