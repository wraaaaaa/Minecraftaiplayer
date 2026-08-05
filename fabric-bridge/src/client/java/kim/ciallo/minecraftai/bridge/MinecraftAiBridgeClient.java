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
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.Locale;
import java.util.UUID;

public final class MinecraftAiBridgeClient implements ClientModInitializer {
    private static volatile MinecraftAiBridgeClient instance;
    private final BridgeConnection bridge = new BridgeConnection();
    private int tick;
    private int lastConnectAttempt = -600;
    private boolean easyAuthSent;
    private boolean easyAuthPromptSeen;
    private boolean dead;
    private int deathTick;
    private int lastRespawnAttempt = -100;
    private int joinedTick;
    private UUID activeSession;
    private boolean bridgeWasConnected;
    private MovementTarget movement;
    private Vec3 movementProgressPosition;
    private int movementNoProgressTicks;
    private int movementDetourTicks;
    private int movementDetourDirection = 1;
    private int movementRecoveryAttempts;
    private PendingSurvivalAction pendingSurvivalAction;
    private final boolean autonomyEnabled = Boolean.parseBoolean(environment("MCAI_AUTONOMY_ENABLED", "true"));
    private final SurvivalController survival = new SurvivalController(
        (float) environmentNumber("MCAI_LOW_HEALTH_THRESHOLD", 10.0D),
        (int) environmentNumber("MCAI_EAT_BELOW_FOOD", 16.0D),
        environmentNumber("MCAI_HOSTILE_SCAN_RADIUS", 12.0D),
        10_000L
    );
    private final WorldStateEncoder worldStateEncoder = new WorldStateEncoder();
    private final PrimitiveTaskController primitives = new PrimitiveTaskController();
    private final ShelterController shelter = new ShelterController();

    @Override
    public void onInitializeClient() {
        instance = this;
        configureApprovedZone();
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
        boolean bridgeConnected = bridge.isConnected();
        if (bridgeWasConnected && !bridgeConnected) {
            movement = null;
            clearMovement(client);
            cancelPendingSurvivalAction("bridge_disconnected");
            primitives.cancel(client, "bridge_disconnected");
            shelter.cancel(client, "bridge_disconnected");
            while (bridge.poll() != null) {
                // Discard commands from the dead controller session; they must never replay.
            }
            drainPrimitiveResults();
            drainShelterResults();
        }
        bridgeWasConnected = bridgeConnected;
        LocalPlayer player = client.player;
        if (player == null || client.level == null) {
            activeSession = null;
            easyAuthSent = false;
            easyAuthPromptSeen = false;
            dead = false;
            movement = null;
            cancelPendingSurvivalAction("world_disconnected");
            primitives.cancel(client, "world_disconnected");
            shelter.cancel(client, "world_disconnected");
            survival.reset(client);
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
        if (handleDeath(client, player)) return;
        if (!easyAuthSent && !easyAuthPromptSeen && tick - joinedTick >= 100 && tick % 20 == 0) sendEasyAuth(player);
        processActions(client, player);
        boolean survivalControlsEnabled = autonomyEnabled || pendingSurvivalAction != null;
        if (survivalControlsEnabled) {
            survival.tick(client);
            resolvePendingSurvivalAction();
        } else {
            SurvivalController.releaseControls(client);
        }
        if (survivalControlsEnabled
            && (survival.mode() == SurvivalController.Mode.EATING || survival.mode() == SurvivalController.Mode.COMBAT)) {
            clearMovement(client);
        } else {
            if (!primitives.activeType().isEmpty()) {
                primitives.tick(client);
            } else if (!shelter.activeType().isEmpty()) {
                shelter.tick(client);
            } else {
                updateMovement(client, player);
            }
        }
        drainPrimitiveResults();
        drainShelterResults();
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

    private static double environmentNumber(String name, double fallback) {
        try {
            String raw = System.getenv(name);
            return raw == null || raw.isBlank() ? fallback : Double.parseDouble(raw.trim());
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private void configureApprovedZone() {
        double minimumPlayerDistance = environmentNumber("MCAI_WILDERNESS_MIN_PLAYER_DISTANCE", 48.0D);
        primitives.setMinimumPlayerDistance(minimumPlayerDistance);
        shelter.setMinimumPlayerDistance(minimumPlayerDistance);
        if (!Boolean.parseBoolean(environment("MCAI_DEVELOPMENT_ZONE_ENABLED", "false"))) {
            primitives.clearApprovedZone();
            shelter.clearApprovedZone();
            return;
        }
        String dimension = environment("MCAI_DEVELOPMENT_ZONE_DIMENSION", "minecraft:overworld");
        BlockPos minimum = new BlockPos(
            (int) environmentNumber("MCAI_DEVELOPMENT_ZONE_MIN_X", 0),
            (int) environmentNumber("MCAI_DEVELOPMENT_ZONE_MIN_Y", 0),
            (int) environmentNumber("MCAI_DEVELOPMENT_ZONE_MIN_Z", 0)
        );
        BlockPos maximum = new BlockPos(
            (int) environmentNumber("MCAI_DEVELOPMENT_ZONE_MAX_X", 0),
            (int) environmentNumber("MCAI_DEVELOPMENT_ZONE_MAX_Y", 0),
            (int) environmentNumber("MCAI_DEVELOPMENT_ZONE_MAX_Z", 0)
        );
        primitives.setApprovedZone(dimension, minimum, maximum);
        shelter.setApprovedZone(dimension, minimum, maximum);
    }

    private boolean handleDeath(Minecraft client, LocalPlayer player) {
        boolean currentlyDead = player.isDeadOrDying() || player.getHealth() <= 0;
        if (!currentlyDead) {
            if (dead) {
                dead = false;
                JsonObject event = baseMessage("respawned");
                event.addProperty("health", player.getHealth());
                bridge.send(event);
            }
            return false;
        }

        if (!dead) {
            dead = true;
            deathTick = tick;
            movement = null;
            clearMovement(client);
            primitives.cancel(client, "bot_died");
            shelter.cancel(client, "bot_died");
            cancelPendingSurvivalAction("bot_died");
            drainPrimitiveResults();
            drainShelterResults();
            JsonObject event = baseMessage("death");
            event.addProperty("health", player.getHealth());
            bridge.send(event);
        }

        if (tick % 20 == 0) bridge.send(buildState(client, player));
        if (!Boolean.parseBoolean(environment("MCAI_AUTO_RESPAWN_ENABLED", "true"))) return true;
        int delayTicks;
        try {
            delayTicks = Math.max(0, Math.min(1200, Integer.parseInt(environment("MCAI_RESPAWN_DELAY_MS", "3000")) / 50));
        } catch (NumberFormatException ignored) {
            delayTicks = 60;
        }
        if (tick - deathTick < delayTicks || tick - lastRespawnAttempt < 100) return true;
        lastRespawnAttempt = tick;
        player.respawn();
        client.gui.setScreen(null);
        JsonObject event = baseMessage("respawn_requested");
        event.addProperty("delayTicks", delayTicks);
        bridge.send(event);
        return true;
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
            String actionType = string(action, "type");
            if (isSurvivalAction(actionType)) {
                if (!primitives.activeType().isEmpty() || !shelter.activeType().isEmpty()) {
                    sendActionResult(id, false, "busy: another verified task is active");
                    continue;
                }
                movement = null;
                clearMovement(client);
                startSurvivalAction(id, actionType, client, player);
                continue;
            }
            if (isPrimitiveAction(actionType)) {
                if (pendingSurvivalAction != null || !shelter.activeType().isEmpty()) {
                    sendActionResult(id, false, "busy: active task is " + activeTaskType());
                    continue;
                }
                movement = null;
                clearMovement(client);
                primitives.start(id, action, client);
                drainPrimitiveResults();
                continue;
            }
            if (isShelterAction(actionType)) {
                if (pendingSurvivalAction != null || !primitives.activeType().isEmpty()) {
                    sendActionResult(id, false, "busy: active task is " + activeTaskType());
                    continue;
                }
                movement = null;
                clearMovement(client);
                shelter.start(id, action, client);
                drainShelterResults();
                continue;
            }
            ActionResult result;
            try {
                result = execute(client, player, action);
            } catch (Exception error) {
                result = new ActionResult(false, error.getClass().getSimpleName() + ": " + error.getMessage());
            }
            sendActionResult(id, result.ok(), result.detail());
        }
    }

    private static boolean isPrimitiveAction(String type) {
        return switch (type) {
            case "equip_best", "prepare_for", "use_item", "collect_own_drops", "gather_resource", "craft_item", "place_block", "drop_item" -> true;
            default -> false;
        };
    }

    private static boolean isSurvivalAction(String type) {
        return "eat_best_food".equals(type) || "attack_hostile".equals(type);
    }

    private static boolean isShelterAction(String type) {
        return "seek_shelter".equals(type) || "build_shelter".equals(type);
    }

    private void drainPrimitiveResults() {
        for (PrimitiveTaskController.TaskResult result : primitives.drainResults()) {
            sendActionResult(result.id(), result.ok(), result.detail());
        }
    }

    private void drainShelterResults() {
        for (ShelterController.TaskResult result : shelter.drainResults()) {
            sendActionResult(result.id(), result.ok(), result.detail());
        }
    }

    private void sendActionResult(String id, boolean ok, String detail) {
        JsonObject response = baseMessage("action_result");
        response.addProperty("id", id);
        response.addProperty("ok", ok);
        response.addProperty("detail", detail);
        bridge.send(response);
    }

    private void startSurvivalAction(String id, String type, Minecraft client, LocalPlayer player) {
        if (pendingSurvivalAction != null) {
            sendActionResult(id, false, "busy: active survival action is " + pendingSurvivalAction.type());
            return;
        }
        if ("eat_best_food".equals(type)
            && player.getFoodData().getFoodLevel() >= 20
            && player.getHealth() > SurvivalController.DEFAULT_EAT_HEALTH_THRESHOLD) {
            sendActionResult(id, true, "当前生命值和饱食度不需要进食");
            return;
        }
        long baseline = "eat_best_food".equals(type)
            ? survival.completedFoodConsumptionCount()
            : survival.successfulAttackCount();
        pendingSurvivalAction = new PendingSurvivalAction(id, type, tick, baseline);
        survival.tick(client);
    }

    private void resolvePendingSurvivalAction() {
        PendingSurvivalAction pending = pendingSurvivalAction;
        if (pending == null) return;
        long observed = "eat_best_food".equals(pending.type())
            ? survival.completedFoodConsumptionCount()
            : survival.successfulAttackCount();
        if (observed > pending.baseline()) {
            pendingSurvivalAction = null;
            sendActionResult(
                pending.id(),
                true,
                "eat_best_food".equals(pending.type())
                    ? "服务端背包状态已确认安全食物被实际食用"
                    : "已在合法距离和视线内实际发出一次敌对生物攻击"
            );
            return;
        }
        long elapsed = tick - pending.startedTick();
        if (elapsed >= 120L
            || (elapsed >= 20L && "attack_hostile".equals(pending.type())
                && survival.mode() != SurvivalController.Mode.COMBAT)) {
            pendingSurvivalAction = null;
            sendActionResult(pending.id(), false, "未观察到动作完成后置条件："
                + survival.snapshot().detail() + "; elapsed_ticks=" + elapsed);
        }
    }

    private void cancelPendingSurvivalAction(String detail) {
        PendingSurvivalAction pending = pendingSurvivalAction;
        if (pending == null) return;
        pendingSurvivalAction = null;
        sendActionResult(pending.id(), false, detail);
    }

    private String activeTaskType() {
        if (pendingSurvivalAction != null) return pendingSurvivalAction.type();
        if (!primitives.activeType().isEmpty()) return primitives.activeType();
        if (!shelter.activeType().isEmpty()) return shelter.activeType();
        return movement == null ? "" : "movement";
    }

    private ActionResult execute(Minecraft client, LocalPlayer player, JsonObject action) {
        return switch (string(action, "type")) {
            case "none" -> new ActionResult(true, "无需动作");
            case "stop" -> {
                movement = null;
                cancelPendingSurvivalAction("stopped_by_command");
                primitives.cancel(client, "stopped_by_command");
                shelter.cancel(client, "stopped_by_command");
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
                setMovement(new MovementTarget(targetName, target.getX(), target.getY(), target.getZ(), "follow_player".equals(string(action, "type")), 2.0), player);
                yield new ActionResult(true, "已开始前往 " + targetName);
            }
            case "wander" -> {
                PrimitiveTaskController.ApprovedZone zone = primitives.approvedZone();
                if (zone == null) yield new ActionResult(false, "refused: no explicit approved exploration AABB");
                if (!zone.dimension().equals(client.level.dimension().identifier().toString())) {
                    yield new ActionResult(false, "refused: approved exploration zone belongs to another dimension");
                }
                if (!zone.contains(player.blockPosition())) {
                    yield new ActionResult(false, "refused: bot is outside approved exploration AABB");
                }
                double radius = Math.max(2, Math.min(8, number(action, "radius", 6)));
                double angle = Math.random() * Math.PI * 2;
                double targetX = Math.max(zone.min().getX() + 0.5D, Math.min(zone.max().getX() + 0.5D,
                    player.getX() + Math.cos(angle) * radius));
                double targetZ = Math.max(zone.min().getZ() + 0.5D, Math.min(zone.max().getZ() + 0.5D,
                    player.getZ() + Math.sin(angle) * radius));
                setMovement(new MovementTarget(null, targetX, player.getY(), targetZ, false, 1.2), player);
                yield new ActionResult(true, "started approved-zone environment exploration");
            }
            case "return_to_zone" -> {
                PrimitiveTaskController.ApprovedZone zone = primitives.approvedZone();
                if (zone == null) yield new ActionResult(false, "refused: no explicit approved development AABB");
                if (!zone.dimension().equals(client.level.dimension().identifier().toString())) {
                    yield new ActionResult(false, "refused: approved development zone belongs to another dimension");
                }
                if (zone.contains(player.blockPosition())) {
                    movement = null;
                    clearMovement(client);
                    yield new ActionResult(true, "already inside approved development AABB");
                }
                double targetX = (zone.min().getX() + zone.max().getX() + 1.0D) / 2.0D;
                double targetZ = (zone.min().getZ() + zone.max().getZ() + 1.0D) / 2.0D;
                double targetY = Math.max(zone.min().getY(), Math.min(zone.max().getY(), player.getY()));
                setMovement(new MovementTarget(null, targetX, targetY, targetZ, false, 1.2), player);
                yield new ActionResult(true, "started returning to approved development AABB");
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
            case "wait_safe" -> {
                SurvivalController.SafetyAssessment safety = SurvivalController.assessSafety(client);
                if (!safety.safeToIdle()) yield new ActionResult(false, "当前位置不适合安全挂机：" + String.join(",", safety.reasons()));
                movement = null;
                clearMovement(client);
                yield new ActionResult(true, "已在安全位置停止移动并进入警戒等待");
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
            movementNoProgressTicks = 0;
            movementRecoveryAttempts = 0;
            if (!target.follow()) movement = null;
            return;
        }
        if (movementProgressPosition == null || player.position().distanceToSqr(movementProgressPosition) >= 0.09D) {
            movementProgressPosition = player.position();
            movementNoProgressTicks = 0;
        } else {
            movementNoProgressTicks++;
        }
        if (movementNoProgressTicks >= 20) {
            movementNoProgressTicks = 0;
            movementRecoveryAttempts++;
            movementDetourDirection *= -1;
            movementDetourTicks = 30;
            if (movementRecoveryAttempts >= 5) {
                movement = null;
                clearMovement(client);
                return;
            }
        }
        driveToward(client, player, new Vec3(target.x(), target.y() + 1.5D, target.z()), distance > 6.0D);
    }

    private void setMovement(MovementTarget target, LocalPlayer player) {
        movement = target;
        movementProgressPosition = player.position();
        movementNoProgressTicks = 0;
        movementDetourTicks = 0;
        movementRecoveryAttempts = 0;
    }

    private void driveToward(Minecraft client, LocalPlayer player, Vec3 target, boolean sprint) {
        clearMovement(client);
        lookAt(player, target.x, target.y, target.z);
        double dx = target.x - player.getX();
        double dz = target.z - player.getZ();
        double length = Math.max(0.001D, Math.sqrt(dx * dx + dz * dz));
        double forwardX = dx / length;
        double forwardZ = dz / length;
        AABB forward = player.getBoundingBox().move(forwardX * 0.55D, 0.0D, forwardZ * 0.55D);
        boolean clearAhead = client.level.noCollision(player, forward);
        boolean supportedAhead = hasSafeLandingBelow(client, player, forward);
        if ((!clearAhead || !supportedAhead || player.horizontalCollision) && movementDetourTicks <= 0) {
            boolean headRoom = client.level.noCollision(player, forward.move(0.0D, 1.0D, 0.0D));
            if (!clearAhead && headRoom && player.onGround()) {
                client.options.keyUp.setDown(true);
                client.options.keyJump.setDown(true);
                return;
            }
            movementDetourTicks = 24;
            movementDetourDirection = chooseDetourDirection(client, player, forwardX, forwardZ);
        }
        client.options.keyUp.setDown(true);
        client.options.keySprint.setDown(sprint && clearAhead && supportedAhead && movementDetourTicks <= 0);
        if (movementDetourTicks > 0) {
            if (movementDetourDirection < 0) client.options.keyLeft.setDown(true);
            else client.options.keyRight.setDown(true);
            client.options.keyJump.setDown(player.horizontalCollision && player.onGround());
            movementDetourTicks--;
        }
    }

    private int chooseDetourDirection(Minecraft client, LocalPlayer player, double forwardX, double forwardZ) {
        double leftX = -forwardZ;
        double leftZ = forwardX;
        AABB left = player.getBoundingBox().move(forwardX * 0.25D + leftX * 0.7D, 0.0D, forwardZ * 0.25D + leftZ * 0.7D);
        AABB right = player.getBoundingBox().move(forwardX * 0.25D - leftX * 0.7D, 0.0D, forwardZ * 0.25D - leftZ * 0.7D);
        boolean leftSafe = client.level.noCollision(player, left) && hasSafeLandingBelow(client, player, left);
        boolean rightSafe = client.level.noCollision(player, right) && hasSafeLandingBelow(client, player, right);
        if (leftSafe != rightSafe) return leftSafe ? -1 : 1;
        return movementDetourDirection == 0 ? 1 : -movementDetourDirection;
    }

    private static boolean hasSafeLandingBelow(Minecraft client, LocalPlayer player, AABB projected) {
        return !client.level.noCollision(player, projected.move(0.0D, -0.7D, 0.0D))
            || !client.level.noCollision(player, projected.move(0.0D, -1.7D, 0.0D));
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
        JsonObject event = worldStateEncoder.encode(client, autonomyEnabled || pendingSurvivalAction != null ? survival : null);
        event.addProperty("type", "state");
        event.addProperty("activePrimitive", activeTaskType());
        event.addProperty("timeOfDay", client.level.getOverworldClockTime());

        ShelterController.HomeSnapshot home = shelter.homeSnapshot();
        if (home != null) {
            JsonObject homeState = new JsonObject();
            homeState.addProperty("dimension", home.dimension());
            homeState.addProperty("x", home.position().getX());
            homeState.addProperty("y", home.position().getY());
            homeState.addProperty("z", home.position().getZ());
            homeState.addProperty("doorX", home.door().getX());
            homeState.addProperty("doorY", home.door().getY());
            homeState.addProperty("doorZ", home.door().getZ());
            homeState.addProperty("persisted", home.persisted());
            event.add("home", homeState);
        }

        JsonArray nearbyPlayers = new JsonArray();
        for (AbstractClientPlayer candidate : client.level.players()) {
            if (candidate == player) continue;
            double distance = candidate.distanceTo(player);
            if (distance > 32) continue;
            JsonObject nearby = new JsonObject();
            nearby.addProperty("name", candidate.getGameProfile().name());
            nearby.addProperty("uuid", candidate.getUUID().toString());
            nearby.addProperty("distance", distance);
            JsonObject pointed = playerPointedBlock(client, candidate);
            if (pointed != null) nearby.add("lookingAtBlock", pointed);
            nearbyPlayers.add(nearby);
        }
        event.add("nearbyPlayers", nearbyPlayers);
        return event;
    }

    private static JsonObject playerPointedBlock(Minecraft client, AbstractClientPlayer player) {
        Vec3 start = player.getEyePosition();
        Vec3 end = start.add(player.getLookAngle().scale(6.0D));
        BlockHitResult hit = client.level.clip(new ClipContext(
            start,
            end,
            ClipContext.Block.OUTLINE,
            ClipContext.Fluid.NONE,
            player
        ));
        if (hit.getType() != HitResult.Type.BLOCK || !client.level.isLoaded(hit.getBlockPos())) return null;
        BlockPos position = hit.getBlockPos();
        JsonObject output = new JsonObject();
        output.addProperty("blockId", BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(position).getBlock()).toString());
        output.addProperty("x", position.getX());
        output.addProperty("y", position.getY());
        output.addProperty("z", position.getZ());
        output.addProperty("distance", start.distanceTo(hit.getLocation()));
        return output;
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

    public static void reportDamage(DamageSource source) {
        MinecraftAiBridgeClient current = instance;
        if (current == null || source == null) return;
        current.survival.noteThreat(source);
        if (source.getEntity() instanceof Player attacker) reportPlayerAttack(attacker);
    }

    private record ActionResult(boolean ok, String detail) { }
    private record MovementTarget(String playerName, double x, double y, double z, boolean follow, double stopDistance) { }
    private record PendingSurvivalAction(String id, String type, int startedTick, long baseline) { }
}
