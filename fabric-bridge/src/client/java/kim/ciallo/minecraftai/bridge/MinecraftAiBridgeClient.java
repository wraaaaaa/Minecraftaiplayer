package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;

import java.util.Locale;
import java.util.UUID;

public final class MinecraftAiBridgeClient implements ClientModInitializer {
    private static volatile MinecraftAiBridgeClient instance;
    private final BridgeConnection bridge = new BridgeConnection();
    private int tick;
    private int lastConnectAttempt = -600;
    private boolean easyAuthSent;
    private boolean easyAuthPromptSeen;
    private int joinedTick;
    private UUID activeSession;
    private MovementTarget movement;

    @Override
    public void onInitializeClient() {
        instance = this;
        bridge.start();
        ClientTickEvents.END_CLIENT_TICK.register(this::onTick);
        ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, boundType, timestamp) -> {
            if (sender == null) return;
            JsonObject event = baseMessage("player_chat");
            event.addProperty("name", sender.name());
            event.addProperty("uuid", sender.id().toString());
            event.addProperty("message", message.getString());
            bridge.send(event);
        });
        ClientReceiveMessageEvents.GAME.register((message, overlay) -> {
            handleEasyAuthPrompt(message.getString());
            JsonObject event = baseMessage("game_message");
            event.addProperty("message", redactLogin(message.getString()));
            event.addProperty("overlay", overlay);
            bridge.send(event);
        });
    }

    private void onTick(Minecraft client) {
        tick++;
        LocalPlayer player = client.player;
        if (player == null || client.level == null) {
            activeSession = null;
            easyAuthSent = false;
            easyAuthPromptSeen = false;
            movement = null;
            autoConnect(client);
            return;
        }
        if (!player.getUUID().equals(activeSession)) {
            activeSession = player.getUUID();
            easyAuthSent = false;
            easyAuthPromptSeen = false;
            joinedTick = tick;
            JsonObject event = baseMessage("joined_world");
            event.addProperty("name", player.getGameProfile().name());
            event.addProperty("uuid", player.getUUID().toString());
            bridge.send(event);
        }
        if (!easyAuthSent && !easyAuthPromptSeen && tick - joinedTick >= 100 && tick % 20 == 0) sendEasyAuth(player);
        processActions(client, player);
        updateMovement(client, player);
        if (tick % 20 == 0) bridge.send(buildState(client, player));
    }

    private void autoConnect(Minecraft client) {
        if (client.getConnection() != null || tick < 40 || tick - lastConnectAttempt < 600) return;
        String host = environment("MCAI_SERVER_HOST", "你的域名.com");
        int port;
        try {
            port = Integer.parseInt(environment("MCAI_SERVER_PORT", "25565"));
        } catch (NumberFormatException ignored) {
            port = 25565;
        }
        port = Math.max(1, Math.min(65535, port));
        lastConnectAttempt = tick;
        String addressText = host + ":" + port;
        ServerAddress address = new ServerAddress(host, port);
        ServerData server = new ServerData("Minecraft AI Server", addressText, ServerData.Type.OTHER);
        ConnectScreen.startConnecting(new TitleScreen(), client, address, server, false, null);
    }

    private static String environment(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private void sendEasyAuth(LocalPlayer player) {
        if (!Boolean.parseBoolean(environment("MCAI_EASYAUTH_ENABLED", "true"))) return;
        String password = System.getenv("MINECRAFT_LOGIN_PASSWORD");
        if (password == null || password.isBlank()) return;
        player.connection.sendCommand("login " + password);
        easyAuthSent = true;
    }

    private void handleEasyAuthPrompt(String message) {
        Minecraft client = Minecraft.getInstance();
        LocalPlayer player = client.player;
        if (player == null || easyAuthSent || !Boolean.parseBoolean(environment("MCAI_EASYAUTH_ENABLED", "true"))) return;
        String password = System.getenv("MINECRAFT_LOGIN_PASSWORD");
        if (password == null || password.isBlank()) return;
        String normalized = message.toLowerCase(Locale.ROOT);
        if (normalized.contains("/register") && Boolean.parseBoolean(environment("MCAI_EASYAUTH_REGISTER_IF_NEEDED", "false"))) {
            easyAuthPromptSeen = true;
            player.connection.sendCommand("register " + password + " " + password);
            easyAuthSent = true;
        } else if (normalized.contains("/login")) {
            easyAuthPromptSeen = true;
            player.connection.sendCommand("login " + password);
            easyAuthSent = true;
        }
    }

    private void processActions(Minecraft client, LocalPlayer player) {
        JsonObject envelope;
        while ((envelope = bridge.poll()) != null) {
            if (!"action".equals(string(envelope, "type"))) continue;
            String id = string(envelope, "id");
            JsonObject action = envelope.has("action") && envelope.get("action").isJsonObject() ? envelope.getAsJsonObject("action") : new JsonObject();
            ActionResult result;
            try {
                result = execute(client, player, action);
            } catch (Exception error) {
                result = new ActionResult(false, error.getClass().getSimpleName() + ": " + error.getMessage());
            }
            JsonObject response = baseMessage("action_result");
            response.addProperty("id", id);
            response.addProperty("ok", result.ok());
            response.addProperty("detail", result.detail());
            bridge.send(response);
        }
    }

    private ActionResult execute(Minecraft client, LocalPlayer player, JsonObject action) {
        return switch (string(action, "type")) {
            case "none" -> new ActionResult(true, "无需动作");
            case "stop" -> {
                movement = null;
                clearMovement(client);
                yield new ActionResult(true, "已停止移动");
            }
            case "chat" -> {
                String message = string(action, "message").replace('\n', ' ').replace('\r', ' ').trim();
                if (message.isEmpty()) yield new ActionResult(false, "聊天内容为空");
                if (message.startsWith("/")) player.connection.sendCommand(message.substring(1));
                else player.connection.sendChat(message.substring(0, Math.min(message.length(), 240)));
                yield new ActionResult(true, "已发送聊天");
            }
            case "follow_player", "come_to_player", "look_at_player" -> {
                String targetName = string(action, "target");
                AbstractClientPlayer target = findPlayer(client, targetName);
                if (target == null) yield new ActionResult(false, "附近找不到玩家 " + targetName);
                if ("look_at_player".equals(string(action, "type"))) {
                    lookAt(player, target.getX(), target.getEyeY(), target.getZ());
                    yield new ActionResult(true, "已看向 " + targetName);
                }
                movement = new MovementTarget(targetName, target.getX(), target.getY(), target.getZ(), "follow_player".equals(string(action, "type")), 2.0);
                yield new ActionResult(true, "已开始前往 " + targetName);
            }
            case "wander" -> {
                double radius = Math.max(2, Math.min(8, number(action, "radius", 6)));
                double angle = Math.random() * Math.PI * 2;
                movement = new MovementTarget(null, player.getX() + Math.cos(angle) * radius, player.getY(), player.getZ() + Math.sin(angle) * radius, false, 1.2);
                yield new ActionResult(true, "已开始安全闲逛");
            }
            case "attack_player" -> {
                String targetName = string(action, "target");
                AbstractClientPlayer target = findPlayer(client, targetName);
                if (target == null) yield new ActionResult(false, "附近找不到攻击者 " + targetName);
                if (client.gameMode == null) yield new ActionResult(false, "游戏交互控制器尚未就绪");
                client.gameMode.attack(player, target);
                player.swing(InteractionHand.MAIN_HAND);
                yield new ActionResult(true, "已对 " + targetName + " 执行一次自卫反击");
            }
            default -> new ActionResult(false, "Fabric 适配器不支持动作 " + string(action, "type"));
        };
    }

    private void updateMovement(Minecraft client, LocalPlayer player) {
        if (movement == null) return;
        MovementTarget target = movement;
        if (target.playerName() != null) {
            AbstractClientPlayer targetPlayer = findPlayer(client, target.playerName());
            if (targetPlayer == null) {
                movement = null;
                clearMovement(client);
                return;
            }
            target = new MovementTarget(target.playerName(), targetPlayer.getX(), targetPlayer.getY(), targetPlayer.getZ(), target.follow(), target.stopDistance());
            movement = target;
        }
        double dx = target.x() - player.getX();
        double dz = target.z() - player.getZ();
        double distance = Math.sqrt(dx * dx + dz * dz);
        if (distance <= target.stopDistance()) {
            clearMovement(client);
            if (!target.follow()) movement = null;
            return;
        }
        lookAt(player, target.x(), target.y() + 1.5, target.z());
        client.options.keyUp.setDown(true);
        client.options.keySprint.setDown(distance > 6);
        client.options.keyJump.setDown(player.horizontalCollision);
    }

    private static void clearMovement(Minecraft client) {
        client.options.keyUp.setDown(false);
        client.options.keyDown.setDown(false);
        client.options.keyLeft.setDown(false);
        client.options.keyRight.setDown(false);
        client.options.keyJump.setDown(false);
        client.options.keySprint.setDown(false);
    }

    private static void lookAt(LocalPlayer player, double x, double y, double z) {
        double dx = x - player.getX();
        double dy = y - player.getEyeY();
        double dz = z - player.getZ();
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        player.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
        player.setXRot((float) -Math.toDegrees(Math.atan2(dy, horizontal)));
    }

    private static AbstractClientPlayer findPlayer(Minecraft client, String name) {
        if (client.level == null) return null;
        for (AbstractClientPlayer candidate : client.level.players()) {
            if (candidate.getGameProfile().name().equalsIgnoreCase(name)) return candidate;
        }
        return null;
    }

    private JsonObject buildState(Minecraft client, LocalPlayer player) {
        JsonObject event = baseMessage("state");
        event.addProperty("connected", true);
        JsonObject position = new JsonObject();
        position.addProperty("x", player.getX());
        position.addProperty("y", player.getY());
        position.addProperty("z", player.getZ());
        event.add("position", position);
        event.addProperty("health", player.getHealth());
        event.addProperty("food", player.getFoodData().getFoodLevel());
        event.addProperty("dimension", client.level.dimension().identifier().toString());
        event.addProperty("timeOfDay", client.level.getOverworldClockTime());

        JsonArray inventory = new JsonArray();
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (stack.isEmpty()) continue;
            JsonObject item = new JsonObject();
            item.addProperty("name", stack.getHoverName().getString());
            item.addProperty("count", stack.getCount());
            inventory.add(item);
        }
        event.add("inventory", inventory);

        JsonArray nearbyPlayers = new JsonArray();
        for (AbstractClientPlayer candidate : client.level.players()) {
            if (candidate == player) continue;
            double distance = candidate.distanceTo(player);
            if (distance > 32) continue;
            JsonObject nearby = new JsonObject();
            nearby.addProperty("name", candidate.getGameProfile().name());
            nearby.addProperty("uuid", candidate.getUUID().toString());
            nearby.addProperty("distance", distance);
            nearbyPlayers.add(nearby);
        }
        event.add("nearbyPlayers", nearbyPlayers);
        return event;
    }

    private static JsonObject baseMessage(String type) {
        JsonObject message = new JsonObject();
        message.addProperty("type", type);
        message.addProperty("at", System.currentTimeMillis());
        return message;
    }

    private static String string(JsonObject object, String key) {
        return object.has(key) && object.get(key).isJsonPrimitive() ? object.get(key).getAsString() : "";
    }

    private static double number(JsonObject object, String key, double fallback) {
        return object.has(key) && object.get(key).isJsonPrimitive() ? object.get(key).getAsDouble() : fallback;
    }

    private static String redactLogin(String text) {
        String redacted = text
            .replaceAll("(?i)/login\\s+\\S+", "/login [REDACTED]")
            .replaceAll("(?i)/register\\s+\\S+(?:\\s+\\S+)?", "/register [REDACTED]");
        String password = System.getenv("MINECRAFT_LOGIN_PASSWORD");
        return password == null || password.isBlank() ? redacted : redacted.replace(password, "[REDACTED]");
    }

    public static void reportPlayerAttack(Player attacker) {
        MinecraftAiBridgeClient current = instance;
        if (current == null) return;
        JsonObject event = baseMessage("attacked_by_player");
        event.addProperty("name", attacker.getGameProfile().name());
        event.addProperty("uuid", attacker.getUUID().toString());
        current.bridge.send(event);
    }

    private record ActionResult(boolean ok, String detail) { }
    private record MovementTarget(String playerName, double x, double y, double z, boolean follow, double stopDistance) { }
}
