package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
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
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.Locale;
import java.util.Set;
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
    private double movementBestDistance = Double.POSITIVE_INFINITY;
    private long movementLastProgressTick;
    private String movementTerminalStatus = "";
    private final LocalPathNavigator movementNavigator = new LocalPathNavigator();
    private final TraversalRecovery traversalRecovery = new TraversalRecovery();
    private BlockPos followPortal;
    private int followTargetMissingSince = -1;
    private String lastWorldDimension = "";
    private final LocalPathNavigator airRescueNavigator = new LocalPathNavigator();
    private BlockPos airRescueExit;
    private int airRescueLastScan = -100;
    private BlockPos airRescueBreaking;
    private long airRescueBreakStarted;
    private PendingSurvivalAction pendingSurvivalAction;
    private PendingNavigation pendingNavigation;
    private PendingStepOn pendingStepOn;
    private String activeGesture = "";
    private int gestureStartedTick;
    private String gestureTargetName;
    private int gestureCircleStep;
    private final String ownerName = environment("MCAI_OWNER_NAME", "wraaaaaa");
    private final boolean autonomyEnabled = Boolean.parseBoolean(environment("MCAI_AUTONOMY_ENABLED", "true"));
    private final boolean firstHomeEnabled = Boolean.parseBoolean(environment("MCAI_FIRST_HOME_ENABLED", "true"));
    private final String firstHomeDimension = environment("MCAI_FIRST_HOME_DIMENSION", "minecraft:overworld");
    private final double firstHomeX = environmentNumber("MCAI_FIRST_HOME_X", 1226.0D);
    private final double firstHomeY = environmentNumber("MCAI_FIRST_HOME_Y", 65.0D);
    private final double firstHomeZ = environmentNumber("MCAI_FIRST_HOME_Z", 199.0D);
    private final double firstHomeRadius = Math.max(1.0D, Math.min(64.0D, environmentNumber("MCAI_FIRST_HOME_RADIUS", 10.0D)));
    private final SurvivalController survival = new SurvivalController(
        (float) environmentNumber("MCAI_LOW_HEALTH_THRESHOLD", 10.0D),
        (int) environmentNumber("MCAI_EAT_BELOW_FOOD", 20.0D),
        environmentNumber("MCAI_HOSTILE_SCAN_RADIUS", 12.0D),
        10_000L,
        ownerName,
        Boolean.parseBoolean(environment("MCAI_PROTECT_OWNER", "true"))
    );
    private final WorldStateEncoder worldStateEncoder = new WorldStateEncoder(ownerName);
    private final PrimitiveTaskController primitives = new PrimitiveTaskController();
    private final AdvancedTaskController advanced = new AdvancedTaskController(primitives);
    private final ShelterController shelter = new ShelterController();
    private final VoicePlaybackManager voicePlayback = new VoicePlaybackManager(this::sendVoiceStatus);

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
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            clearMovement(client);
            cancelPendingSurvivalAction("bridge_disconnected");
            cancelPendingNavigation(client, "bridge_disconnected");
            cancelPendingStepOn(client, "bridge_disconnected");
            primitives.cancel(client, "bridge_disconnected");
            advanced.cancel(client, "bridge_disconnected");
            shelter.cancel(client, "bridge_disconnected");
            voicePlayback.cancel("bridge_disconnected");
            while (bridge.poll() != null) {
                // 丢弃来自已失效控制器会话的命令；它们绝不能被重放。
            }
            drainPrimitiveResults();
            drainAdvancedResults();
            drainShelterResults();
        }
        bridgeWasConnected = bridgeConnected;
        LocalPlayer player = client.player;
        if (player == null || client.level == null) {
            boolean preservePersistentFollow = movement != null && movement.follow() && client.getConnection() != null && bridgeConnected;
            activeSession = null;
            easyAuthSent = false;
            easyAuthPromptSeen = false;
            dead = false;
            if (!preservePersistentFollow) movement = null;
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            cancelPendingSurvivalAction("world_disconnected");
            cancelPendingNavigation(client, "world_disconnected");
            cancelPendingStepOn(client, "world_disconnected");
            primitives.cancel(client, "world_disconnected");
            advanced.cancel(client, "world_disconnected");
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
        String currentDimension = client.level.dimension().identifier().toString();
        if (!lastWorldDimension.isEmpty() && !lastWorldDimension.equals(currentDimension)) {
            // 跨越传送门 / 切换维度：释放旧维度路径状态，但保留持续跟随，进入新维度后重新定位被跟随玩家。
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            followPortal = null;
            followTargetMissingSince = -1;
            lastWorldDimension = currentDimension;
        }
        if (handleDeath(client, player)) return;
        if (!easyAuthSent && !easyAuthPromptSeen && tick - joinedTick >= 100 && tick % 20 == 0) sendEasyAuth(player);
        processActions(client, player);
        survival.setEscortPlayerName(movement != null && movement.follow() ? movement.playerName() : "");
        boolean survivalControlsEnabled = autonomyEnabled || pendingSurvivalAction != null;
        if (survivalControlsEnabled) {
            survival.tick(client);
            resolvePendingSurvivalAction();
        } else {
            SurvivalController.releaseControls(client);
        }
        boolean advancedCombat = "attack_hostile".equals(advanced.activeType());
        boolean surfacingForAir = survivalControlsEnabled && "surfacing_for_air".equals(survival.snapshot().detail());
        if (surfacingForAir) {
            rescueAir(client, player);
        } else if (survivalControlsEnabled
            && (survival.mode() == SurvivalController.Mode.EATING
                || survival.mode() == SurvivalController.Mode.COMBAT && !advancedCombat)) {
            stopAirRescue(client);
            clearMovement(client);
        } else {
            stopAirRescue(client);
            if (!primitives.activeType().isEmpty()) {
                primitives.tick(client);
            } else if (!advanced.activeType().isEmpty()) {
                advanced.tick(client);
            } else if (!shelter.activeType().isEmpty()) {
                shelter.tick(client);
            } else {
                updateMovement(client, player);
            }
        }
        drainPrimitiveResults();
        drainAdvancedResults();
        drainShelterResults();
        resolvePendingNavigation(client, player);
        resolvePendingStepOn(client, player);
        tickGesture(client);
        if (tick % 20 == 0) bridge.send(buildState(client, player));
    }

    private void rescueAir(Minecraft client, LocalPlayer player) {
        clearMovement(client);
        if (airRescueBreaking != null
            && (!client.level.isLoaded(airRescueBreaking) || client.level.getBlockState(airRescueBreaking).isAir())) {
            if (client.gameMode != null) client.gameMode.stopDestroyBlock();
            airRescueBreaking = null;
        }
        if (airRescueExit == null
            || tick - airRescueLastScan >= 20
            || !isBreathableWaterSurface(client, airRescueExit)) {
            airRescueExit = nearestBreathableWaterSurface(client, player, 12);
            airRescueLastScan = tick;
        }
        BlockPos exit = airRescueExit;
        if (exit != null) {
            boolean routed = airRescueNavigator.drive(
                client, player, Vec3.atBottomCenterOf(exit), 0.45D, false, tick
            );
            double dx = player.getX() - (exit.getX() + 0.5D);
            double dz = player.getZ() - (exit.getZ() + 0.5D);
            if (dx * dx + dz * dz <= 0.81D && player.getY() >= exit.getY() - 0.8D) {
                client.options.keyJump.setDown(true);
            }
            if (routed) return;
        }

        airRescueNavigator.release(client);
        BlockPos roof = reachableNaturalAirRoof(client, player);
        if (roof != null && client.gameMode != null) {
            BlockState state = client.level.getBlockState(roof);
            if (airRescueBreaking == null || !airRescueBreaking.equals(roof)) {
                if (airRescueBreaking != null) client.gameMode.stopDestroyBlock();
                airRescueBreaking = roof.immutable();
                airRescueBreakStarted = tick;
                if (!ToolSelector.ensureBestMiningTool(client, player, state)) return;
                client.gameMode.startDestroyBlock(airRescueBreaking, Direction.DOWN);
            }
            lookAt(player, roof.getX() + 0.5D, roof.getY() + 0.15D, roof.getZ() + 0.5D);
            client.gameMode.continueDestroyBlock(airRescueBreaking, Direction.DOWN);
            player.swing(InteractionHand.MAIN_HAND);
            if (client.level.getBlockState(airRescueBreaking).isAir() || tick - airRescueBreakStarted > 100L) {
                client.gameMode.stopDestroyBlock();
                airRescueBreaking = null;
            }
        }
        // 继续上浮，同时寻找边缘，或把天然的冰/雪顶棚纳入可触及范围。
        client.options.keyJump.setDown(true);
    }

    private void stopAirRescue(Minecraft client) {
        airRescueNavigator.release(client);
        if (airRescueBreaking != null && client != null && client.gameMode != null) {
            client.gameMode.stopDestroyBlock();
        }
        airRescueBreaking = null;
        airRescueExit = null;
        airRescueLastScan = -100;
    }

    private static boolean isBreathableWaterSurface(Minecraft client, BlockPos water) {
        if (water == null || !client.level.isLoaded(water)) return false;
        BlockPos breathing = water.above();
        BlockPos head = breathing.above();
        if (!client.level.isLoaded(breathing) || !client.level.isLoaded(head)
            || !client.level.getFluidState(water).is(FluidTags.WATER)) return false;
        BlockState breathingState = client.level.getBlockState(breathing);
        BlockState headState = client.level.getBlockState(head);
        return breathingState.getFluidState().isEmpty()
            && breathingState.getCollisionShape(client.level, breathing).isEmpty()
            && headState.getCollisionShape(client.level, head).isEmpty();
    }

    private static BlockPos nearestBreathableWaterSurface(Minecraft client, LocalPlayer player, int radius) {
        BlockPos origin = player.blockPosition();
        BlockPos best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        for (int y = Math.max(client.level.getMinY(), origin.getY() - 1);
             y <= Math.min(client.level.getMaxY() - 3, origin.getY() + radius); y++) {
            for (int x = origin.getX() - radius; x <= origin.getX() + radius; x++) {
                for (int z = origin.getZ() - radius; z <= origin.getZ() + radius; z++) {
                    BlockPos water = new BlockPos(x, y, z);
                    if (!isBreathableWaterSurface(client, water)) continue;
                    double dx = x + 0.5D - player.getX();
                    double dz = z + 0.5D - player.getZ();
                    double score = Math.sqrt(dx * dx + dz * dz) + Math.max(0, y - player.getY()) * 0.35D;
                    if (score < bestScore) {
                        best = water.immutable();
                        bestScore = score;
                    }
                }
            }
        }
        return best;
    }

    private static BlockPos reachableNaturalAirRoof(Minecraft client, LocalPlayer player) {
        BlockPos origin = player.blockPosition();
        for (int dy = 1; dy <= 4; dy++) {
            BlockPos position = origin.above(dy);
            if (!client.level.isLoaded(position)) return null;
            BlockState state = client.level.getBlockState(position);
            if (!state.getFluidState().isEmpty() || state.isAir()) continue;
            if (player.distanceToSqr(Vec3.atCenterOf(position)) <= 25.0D
                && WildernessGuard.safeNaturalBreak(client, position)
                && state.getDestroySpeed(client.level, position) >= 0.0F) return position;
            return null;
        }
        return null;
    }

    private void autoConnect(Minecraft client) {
        if (client.getConnection() != null || tick < 40 || tick - lastConnectAttempt < 600) return;
        String host = environment("MCAI_SERVER_HOST", "127.0.0.1");
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
        advanced.setMinimumPlayerDistance(minimumPlayerDistance);
        shelter.setMinimumPlayerDistance(minimumPlayerDistance);
        // 手动 AABB 授权已移除。模型意图改由实时世界状态评估，
        // 而 PrimitiveTaskController/WildernessGuard 仍然验证每一次世界变更。
        primitives.clearApprovedZone();
        shelter.clearApprovedZone();
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
            advanced.cancel(client, "bot_died");
            shelter.cancel(client, "bot_died");
            cancelPendingSurvivalAction("bot_died");
            cancelPendingNavigation(client, "bot_died");
            cancelPendingStepOn(client, "bot_died");
            drainPrimitiveResults();
            drainAdvancedResults();
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
            action = normalizeAgentPrimitive(action);
            String actionType = string(action, "type");
            if (actionType.startsWith("voice_playback_")) {
                VoicePlaybackManager.Result voiceResult = voicePlayback.handle(action);
                sendActionResult(id, voiceResult.ok(), voiceResult.detail());
                continue;
            }
            if ("navigate_to".equals(actionType)) {
                if (pendingNavigation != null || pendingSurvivalAction != null || !primitives.activeType().isEmpty()
                    || !advanced.activeType().isEmpty() || !shelter.activeType().isEmpty()) {
                    sendActionResult(id, false, "busy: active task is " + activeTaskType());
                    continue;
                }
                double x = number(action, "x", Double.NaN);
                double y = number(action, "y", Double.NaN);
                double z = number(action, "z", Double.NaN);
                double stopDistance = Math.max(0.5D, Math.min(4.0D, number(action, "stopDistance", 1.2D)));
                if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)) {
                    sendActionResult(id, false, "invalid navigate_to coordinates");
                    continue;
                }
                if (!setMovement(new MovementTarget(null, x, y, z, false, stopDistance), player)) {
                    sendActionResult(id, false, "no collision-safe loaded route to requested coordinate");
                    continue;
                }
                pendingNavigation = new PendingNavigation(id, x, y, z, stopDistance, tick);
                continue;
            }
            if ("step_on_block".equals(actionType)) {
                if (pendingNavigation != null || pendingStepOn != null || pendingSurvivalAction != null
                    || !primitives.activeType().isEmpty() || !advanced.activeType().isEmpty() || !shelter.activeType().isEmpty()) {
                    sendActionResult(id, false, "busy: active task is " + activeTaskType());
                    continue;
                }
                BlockPos target = new BlockPos((int) number(action, "x", Integer.MIN_VALUE), (int) number(action, "y", Integer.MIN_VALUE), (int) number(action, "z", Integer.MIN_VALUE));
                if (!client.level.isLoaded(target)) {
                    sendActionResult(id, false, "step_on_block target is unloaded");
                    continue;
                }
                BlockState state = client.level.getBlockState(target);
                String blockId = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
                if (!blockId.endsWith("_pressure_plate") && !blockId.equals("minecraft:tripwire")) {
                    sendActionResult(id, false, "step_on_block requires a pressure plate or tripwire; got " + blockId);
                    continue;
                }
                Vec3 center = LocalPathNavigator.standingCenter(client, player, target);
                if (!setMovement(new MovementTarget(null, center.x, center.y, center.z, false, 0.22), player)) {
                    sendActionResult(id, false, "no collision-safe route onto pressure plate");
                    continue;
                }
                pendingStepOn = new PendingStepOn(id, target, tick);
                continue;
            }
            if (isSurvivalAction(actionType)) {
                if (!primitives.activeType().isEmpty() || !advanced.activeType().isEmpty() || !shelter.activeType().isEmpty()) {
                    sendActionResult(id, false, "busy: another verified task is active");
                    continue;
                }
                movement = null;
                traversalRecovery.reset(client);
                clearMovement(client);
                startSurvivalAction(id, actionType, client, player);
                continue;
            }
            if (isAdvancedAction(actionType)) {
                if (pendingSurvivalAction != null || !primitives.activeType().isEmpty() || !shelter.activeType().isEmpty()) {
                    sendActionResult(id, false, "busy: active task is " + activeTaskType());
                    continue;
                }
                movement = null;
                traversalRecovery.reset(client);
                clearMovement(client);
                advanced.start(id, action, client);
                drainAdvancedResults();
                continue;
            }
            if (isPrimitiveAction(actionType)) {
                if (pendingSurvivalAction != null || !advanced.activeType().isEmpty() || !shelter.activeType().isEmpty()) {
                    sendActionResult(id, false, "busy: active task is " + activeTaskType());
                    continue;
                }
                movement = null;
                traversalRecovery.reset(client);
                clearMovement(client);
                primitives.start(id, action, client);
                drainPrimitiveResults();
                continue;
            }
            if (isShelterAction(actionType)) {
                if (pendingSurvivalAction != null || !primitives.activeType().isEmpty() || !advanced.activeType().isEmpty()) {
                    sendActionResult(id, false, "busy: active task is " + activeTaskType());
                    continue;
                }
                movement = null;
                traversalRecovery.reset(client);
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
            case "equip_best", "prepare_for", "unequip_armor", "make_inventory_room", "use_item", "collect_own_drops", "gather_resource", "craft_item", "place_block", "drop_item" -> true;
            default -> false;
        };
    }

    private static JsonObject normalizeAgentPrimitive(JsonObject original) {
        String type = string(original, "type");
        JsonObject action = original.deepCopy();
        if ("break_block_at".equals(type)) {
            action.addProperty("type", "gather_resource");
            action.addProperty("resource", string(original, "expectedBlockId"));
            action.addProperty("count", 1);
            action.addProperty("verifiedWilderness", true);
            JsonObject target = new JsonObject();
            target.addProperty("x", number(original, "x", Double.NaN));
            target.addProperty("y", number(original, "y", Double.NaN));
            target.addProperty("z", number(original, "z", Double.NaN));
            action.add("targetBlock", target);
        } else if ("place_block_at".equals(type)) {
            action.addProperty("type", "place_block");
            action.addProperty("count", 1);
            action.addProperty("verifiedWilderness", true);
            JsonObject target = new JsonObject();
            target.addProperty("x", number(original, "x", Double.NaN));
            target.addProperty("y", number(original, "y", Double.NaN));
            target.addProperty("z", number(original, "z", Double.NaN));
            action.add("targetBlock", target);
        } else if ("craft_recipe".equals(type)) {
            action.addProperty("type", "craft_item");
            // Agent-v2 没有由模型控制的授权标志。CreateCraftTask 仍会推导出一个
            // 短时效的 WildernessGuard 工作窗口，并要求工作台经过账本验证后，
            // 任何 3x3 配方才能运行。
            action.addProperty("verifiedWilderness", true);
        } else if ("use_held_item".equals(type)) {
            action.addProperty("type", "use_item");
        }
        return action;
    }

    private static boolean isSurvivalAction(String type) {
        return "eat_best_food".equals(type);
    }

    private static boolean isAdvancedAction(String type) {
        return switch (type) {
            case "attack_hostile", "hunt_entity", "ranged_attack_continuously", "combat_continuously", "accept_items", "smelt_item", "trade_villager", "enchant_item",
                "sleep_in_bed", "excavate_tunnel", "explore_frontier", "build_nether_portal", "travel_to_dimension" -> true;
            default -> false;
        };
    }

    private static boolean isShelterAction(String type) {
        return "seek_shelter".equals(type) || "build_shelter".equals(type);
    }

    private void drainPrimitiveResults() {
        for (PrimitiveTaskController.TaskResult result : primitives.drainResults()) {
            sendActionResult(result.id(), result.ok(), result.detail());
        }
    }

    private void drainAdvancedResults() {
        for (AdvancedTaskController.TaskResult result : advanced.drainResults()) {
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

    private void sendVoiceStatus(VoicePlaybackManager.Status status) {
        JsonObject response = baseMessage("voice_status");
        response.addProperty("ok", status.ok());
        response.addProperty("detail", status.detail());
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
        pendingSurvivalAction = new PendingSurvivalAction(
            id,
            type,
            tick,
            baseline,
            player.getFoodData().getFoodLevel(),
            player.getHealth()
        );
        survival.tick(client);
    }

    private void resolvePendingSurvivalAction() {
        PendingSurvivalAction pending = pendingSurvivalAction;
        if (pending == null) return;
        long observed = "eat_best_food".equals(pending.type())
            ? survival.completedFoodConsumptionCount()
            : survival.successfulAttackCount();
        LocalPlayer player = Minecraft.getInstance().player;
        boolean survivalValueImproved = "eat_best_food".equals(pending.type())
            && player != null
            && (player.getFoodData().getFoodLevel() > pending.baselineFood()
                || player.getHealth() > pending.baselineHealth());
        if (observed > pending.baseline() || survivalValueImproved) {
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
            if ("eat_best_food".equals(pending.type())) survival.cancelFoodUse(Minecraft.getInstance());
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
        if (pendingNavigation != null) return "navigate_to";
        if (pendingStepOn != null) return "step_on_block";
        if (pendingSurvivalAction != null) return pendingSurvivalAction.type();
        if (!primitives.activeType().isEmpty()) return primitives.activeType();
        if (!advanced.activeType().isEmpty()) return advanced.activeType();
        if (!shelter.activeType().isEmpty()) return shelter.activeType();
        if (movement == null) return "";
        if (movement.follow() && movement.playerName() != null) return "follow_player";
        if (movement.follow()) return "return_home";
        return "movement";
    }

    private ActionResult execute(Minecraft client, LocalPlayer player, JsonObject action) {
        return switch (string(action, "type")) {
            case "none" -> new ActionResult(true, "无需动作");
            case "stop" -> {
                movement = null;
                movementTerminalStatus = "";
                movementNavigator.release(client);
                traversalRecovery.reset(client);
                cancelPendingNavigation(client, "stopped_by_command");
                cancelPendingStepOn(client, "stopped_by_command");
                cancelPendingSurvivalAction("stopped_by_command");
                primitives.cancel(client, "stopped_by_command");
                advanced.cancel(client, "stopped_by_command");
                shelter.cancel(client, "stopped_by_command");
                activeGesture = "";
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
            case "look_at" -> {
                double x = number(action, "x", Double.NaN);
                double y = number(action, "y", Double.NaN);
                double z = number(action, "z", Double.NaN);
                if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)) yield new ActionResult(false, "invalid look coordinates");
                lookAt(player, x, y, z);
                yield new ActionResult(true, "view_rotation_updated");
            }
            case "select_hotbar" -> {
                int slot = (int) number(action, "slot", -1);
                if (slot < 0 || slot >= 9) yield new ActionResult(false, "hotbar slot must be 0..8");
                player.getInventory().setSelectedSlot(slot);
                player.connection.send(new ServerboundSetCarriedItemPacket(slot));
                yield new ActionResult(true, "selected_hotbar_slot=" + slot);
            }
            case "attack_entity" -> {
                Entity target = entity(client, string(action, "entityId"));
                if (!(target instanceof LivingEntity living) || target instanceof Player) yield new ActionResult(false, "target is missing, non-living, or a player");
                if (!living.isAlive()) yield new ActionResult(false, "target is not alive");
                if (player.distanceTo(target) > 4.5D || !player.hasLineOfSight(target)) yield new ActionResult(false, "target is outside legal melee distance or line of sight");
                if (client.gameMode == null) yield new ActionResult(false, "game interaction controller unavailable");
                float before = living.getHealth();
                client.gameMode.attack(player, target);
                player.swing(InteractionHand.MAIN_HAND);
                yield new ActionResult(true, "attack_sent; entity_id=" + target.getId() + "; observed_health_before=" + before);
            }
            case "interact_entity" -> {
                Entity target = entity(client, string(action, "entityId"));
                if (target == null || target instanceof Player) yield new ActionResult(false, "target is missing or is a player");
                if (player.distanceTo(target) > 5.0D || !player.hasLineOfSight(target)) yield new ActionResult(false, "target is outside interaction distance or line of sight");
                InteractionResult interaction = client.gameMode.interact(player, target, new EntityHitResult(target), InteractionHand.MAIN_HAND);
                if (!interaction.consumesAction()) yield new ActionResult(false, "entity interaction rejected");
                player.swing(InteractionHand.MAIN_HAND);
                yield new ActionResult(true, "entity_interaction_accepted; entity_id=" + target.getId());
            }
            case "interact_block" -> interactBlock(client, player, action);
            case "drop_inventory_item" -> dropInventoryItem(client, player, action);
            case "discard_inventory_items" -> discardInventoryItems(client, player, action);
            case "discard_worn_tools" -> discardWornTools(client, player, action);
            case "gesture" -> startGesture(action);
            case "send_server_command" -> {
                String command = string(action, "command").trim().replaceFirst("^/+", "");
                if (!command.matches("(?i)(?:tp|teleport)\\s+[A-Za-z0-9_]{1,16}")) {
                    yield new ActionResult(false, "policy_denied: only self-to-player tp/teleport is allowed");
                }
                if (!Boolean.parseBoolean(environment("MCAI_TP_COMMAND_ENABLED", "false"))) {
                    yield new ActionResult(false, "permission_not_configured: tp is disabled until an administrator grants the Bot permission and enables MCAI_TP_COMMAND_ENABLED");
                }
                player.connection.sendCommand(command);
                yield new ActionResult(true, "command_sent; server_confirmation_pending");
            }
            case "follow_player", "come_to_player", "look_at_player" -> {
                String targetName = string(action, "target");
                AbstractClientPlayer target = findPlayer(client, targetName);
                if (target == null && !targetName.equalsIgnoreCase(ownerName)) {
                    yield new ActionResult(false, "附近找不到玩家 " + targetName);
                }
                if ("look_at_player".equals(string(action, "type"))) {
                    if (target == null) yield new ActionResult(false, "最高优先玩家当前只提供远距离方位，无法精确注视");
                    lookAt(player, target.getX(), target.getEyeY(), target.getZ());
                    yield new ActionResult(true, "已看向 " + targetName);
                }
                Vec3 goal;
                if (target != null) {
                    goal = target.position();
                } else {
                    OwnerLocator.Fix fix = OwnerLocator.locate(client, player, ownerName);
                    if (fix == null) yield new ActionResult(false, "服务器没有提供最高优先玩家的定位栏方位");
                    goal = fix.segmentGoal(player, 22.0D);
                }
                boolean continuousFollow = "follow_player".equals(string(action, "type"));
                if (!setMovement(new MovementTarget(targetName, goal.x, goal.y, goal.z, continuousFollow, 3.0), player)) {
                    yield new ActionResult(false, "no collision-safe loaded route to player " + targetName);
                }
                yield new ActionResult(true, continuousFollow
                    ? "continuous_follow_engaged; dynamic_replan_and_terrain_recovery_enabled; target=" + targetName
                    : target == null ? "已按服务器定位栏方位开始寻找最高优先玩家" : "已开始前往 " + targetName);
            }
            case "wander" -> {
                double radius = Math.max(2, Math.min(8, number(action, "radius", 6)));
                boolean started = false;
                for (int attempt = 0; attempt < 12 && !started; attempt++) {
                    double angle = Math.random() * Math.PI * 2;
                    double distance = radius * (0.55D + Math.random() * 0.45D);
                    double targetX = player.getX() + Math.cos(angle) * distance;
                    double targetZ = player.getZ() + Math.sin(angle) * distance;
                    started = setMovement(new MovementTarget(null, targetX, player.getY(), targetZ, false, 1.2), player);
                }
                if (!started) yield new ActionResult(false, "no collision-safe loaded route selected from twelve environment-aware candidates");
                yield new ActionResult(true, "started environment-aware short exploration");
            }
            case "return_to_zone" -> {
                yield new ActionResult(false, "manual development zones were removed; use explore_frontier, seek_shelter, or come_to_player");
            }
            case "return_home" -> {
                String currentDimension = client.level.dimension().identifier().toString();
                ShelterController.HomeSnapshot registered = shelter.homeSnapshot();
                double x;
                double y;
                double z;
                double radius;
                String source;
                if (registered != null && registered.dimension().equals(currentDimension)) {
                    x = registered.position().getX() + 0.5D;
                    y = registered.position().getY();
                    z = registered.position().getZ() + 0.5D;
                    radius = 2.0D;
                    source = "registered_shelter";
                } else if (firstHomeEnabled && firstHomeDimension.equals(currentDimension)) {
                    x = firstHomeX;
                    y = firstHomeY;
                    z = firstHomeZ;
                    radius = firstHomeRadius;
                    source = "first_home";
                } else {
                    yield new ActionResult(false, "home_is_in_another_dimension; current=" + currentDimension
                        + "; registered=" + (registered == null ? "none" : registered.dimension())
                        + "; first_home=" + firstHomeDimension);
                }
                if (!setMovement(new MovementTarget(null, x, y, z, true, radius), player)) {
                    yield new ActionResult(false, "cannot_start_collision_safe_home_route");
                }
                yield new ActionResult(true, "return_home_engaged; source=" + source + "; destination="
                    + x + "," + y + "," + z + "; stop_radius=" + radius);
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
                movementTerminalStatus = "";
                traversalRecovery.reset(client);
                clearMovement(client);
                yield new ActionResult(true, "已在安全位置停止移动并进入警戒等待");
            }
            default -> new ActionResult(false, "Fabric 适配器不支持动作 " + string(action, "type"));
        };
    }

    private void resolvePendingNavigation(Minecraft client, LocalPlayer player) {
        PendingNavigation pending = pendingNavigation;
        if (pending == null) return;
        double dx = pending.x() - player.getX();
        double dz = pending.z() - player.getZ();
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        if (horizontal <= pending.stopDistance()) {
            pendingNavigation = null;
            movement = null;
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            clearMovement(client);
            sendActionResult(pending.id(), true, "navigation_reached; distance=" + horizontal);
            return;
        }
        if (movement == null) {
            pendingNavigation = null;
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            clearMovement(client);
            sendActionResult(pending.id(), false, "navigation_failed: no collision-safe route; last_distance=" + horizontal);
            return;
        }
        if (tick - pending.startedTick() > 600L) {
            pendingNavigation = null;
            movement = null;
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            clearMovement(client);
            sendActionResult(pending.id(), false, "navigation_timeout; last_distance=" + horizontal + "; status=" + movementNavigator.status());
        }
    }

    private void cancelPendingNavigation(Minecraft client, String detail) {
        PendingNavigation pending = pendingNavigation;
        if (pending == null) return;
        pendingNavigation = null;
        movement = null;
        movementNavigator.release(client);
        traversalRecovery.reset(client);
        clearMovement(client);
        sendActionResult(pending.id(), false, detail);
    }

    private void resolvePendingStepOn(Minecraft client, LocalPlayer player) {
        PendingStepOn pending = pendingStepOn;
        if (pending == null) return;
        BlockState state = client.level.getBlockState(pending.block());
        boolean powered = state.hasProperty(BlockStateProperties.POWERED) && state.getValue(BlockStateProperties.POWERED)
            || state.hasProperty(BlockStateProperties.POWER) && state.getValue(BlockStateProperties.POWER) > 0;
        double dx = player.getX() - (pending.block().getX() + 0.5D);
        double dz = player.getZ() - (pending.block().getZ() + 0.5D);
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        boolean standing = horizontal <= 0.55D && Math.abs(player.getY() - (pending.block().getY() + 0.0625D)) <= 0.7D;
        if (powered && standing) {
            pendingStepOn = null;
            movement = null;
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            clearMovement(client);
            sendActionResult(pending.id(), true, "stepped_on_actuator; block=" + BuiltInRegistries.BLOCK.getKey(state.getBlock()) + "; powered=true");
            return;
        }
        if (tick - pending.startedTick() > 240L) {
            pendingStepOn = null;
            movement = null;
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            clearMovement(client);
            sendActionResult(pending.id(), false, "step_on_timeout; horizontal=" + horizontal + "; powered=" + powered);
        }
    }

    private void cancelPendingStepOn(Minecraft client, String detail) {
        PendingStepOn pending = pendingStepOn;
        if (pending == null) return;
        pendingStepOn = null;
        movement = null;
        movementNavigator.release(client);
        traversalRecovery.reset(client);
        clearMovement(client);
        sendActionResult(pending.id(), false, detail);
    }

    private static Entity entity(Minecraft client, String rawId) {
        if (client.level == null || rawId == null || !rawId.matches("-?\\d+")) return null;
        try { return client.level.getEntity(Integer.parseInt(rawId)); }
        catch (NumberFormatException ignored) { return null; }
    }

    private static ActionResult interactBlock(Minecraft client, LocalPlayer player, JsonObject action) {
        if (client.gameMode == null || client.level == null) return new ActionResult(false, "game interaction controller unavailable");
        BlockPos target = new BlockPos((int) number(action, "x", Integer.MIN_VALUE), (int) number(action, "y", Integer.MIN_VALUE), (int) number(action, "z", Integer.MIN_VALUE));
        if (!client.level.isLoaded(target) || !player.isWithinBlockInteractionRange(target, 0.0D)) return new ActionResult(false, "block is unloaded or outside interaction range");
        BlockState state = client.level.getBlockState(target);
        String blockId = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        if (client.level.getBlockEntity(target) != null && !OwnedBlockRegistry.isOwned(client, target, blockId)) {
            return new ActionResult(false, "policy_denied: block entity is not proven bot-owned");
        }
        lookAt(player, target.getX() + 0.5D, target.getY() + 0.5D, target.getZ() + 0.5D);
        BlockHitResult sight = client.level.clip(new ClipContext(player.getEyePosition(), Vec3.atCenterOf(target), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
        if (sight.getType() != HitResult.Type.BLOCK || !sight.getBlockPos().equals(target)) return new ActionResult(false, "block is not in line of sight");
        InteractionHand hand = "off".equalsIgnoreCase(string(action, "hand")) ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
        InteractionResult result = client.gameMode.useItemOn(player, hand, sight);
        if (!result.consumesAction()) return new ActionResult(false, "block interaction rejected: " + blockId);
        player.swing(hand);
        return new ActionResult(true, "block_interaction_accepted; block=" + blockId + "; target=" + target.toShortString());
    }

    private ActionResult dropInventoryItem(Minecraft client, LocalPlayer player, JsonObject action) {
        if (client.gameMode == null || player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
            return new ActionResult(false, "normal inventory with empty cursor is required");
        }
        int slot = (int) number(action, "slot", -1);
        int requested = (int) number(action, "count", 1);
        if (slot < 0 || slot >= player.getInventory().getNonEquipmentItems().size()) return new ActionResult(false, "invalid inventory slot");
        ItemStack stack = player.getInventory().getItem(slot);
        if (stack.isEmpty()) return new ActionResult(false, "inventory slot is empty");
        String authorizedPlayer = action.has("authorizedPlayer") && !action.get("authorizedPlayer").isJsonNull() ? action.get("authorizedPlayer").getAsString() : null;
        if (InventoryCleanup.isValuable(stack) && authorizedPlayer != null && !authorizedPlayer.equalsIgnoreCase(ownerName)) {
            return new ActionResult(false, "refused: valuable item requires owner authorization");
        }
        int count = Math.max(1, Math.min(requested, stack.getCount()));
        int menuSlot = slot < 9 ? InventoryMenu.USE_ROW_SLOT_START + slot : slot;
        if (count == stack.getCount()) {
            client.gameMode.handleContainerInput(player.inventoryMenu.containerId, menuSlot, 1, ContainerInput.THROW, player);
        } else {
            for (int index = 0; index < count; index++) client.gameMode.handleContainerInput(player.inventoryMenu.containerId, menuSlot, 0, ContainerInput.THROW, player);
        }
        return new ActionResult(true, "drop_requested; slot=" + slot + "; count=" + count);
    }

    /** 仪表盘背包整理：按槽位丢弃指定数量，随后后退 5 格避免再次拾取刚丢出的物品。 */
    private ActionResult discardInventoryItems(Minecraft client, LocalPlayer player, JsonObject action) {
        if (client.gameMode == null || player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
            return new ActionResult(false, "normal inventory with empty cursor is required");
        }
        JsonArray slots = action.has("slots") && action.get("slots").isJsonArray() ? action.getAsJsonArray("slots") : new JsonArray();
        if (slots.isEmpty()) return new ActionResult(false, "no discard slots provided");
        boolean forceValuable = action.has("forceValuable") && !action.get("forceValuable").isJsonNull() && action.get("forceValuable").getAsBoolean();
        int discardedStacks = 0;
        int discardedItems = 0;
        int skippedValuable = 0;
        for (JsonElement element : slots) {
            if (!element.isJsonObject()) continue;
            JsonObject request = element.getAsJsonObject();
            int slot = (int) number(request, "slot", -1);
            if (slot < 0 || slot >= player.getInventory().getNonEquipmentItems().size()) continue;
            ItemStack stack = player.getInventory().getItem(slot);
            if (stack.isEmpty()) continue;
            if (InventoryCleanup.isValuable(stack) && !forceValuable) { skippedValuable++; continue; }
            int count = Math.max(1, Math.min((int) number(request, "count", stack.getCount()), stack.getCount()));
            int menuSlot = slot < 9 ? InventoryMenu.USE_ROW_SLOT_START + slot : slot;
            if (count == stack.getCount()) {
                client.gameMode.handleContainerInput(player.inventoryMenu.containerId, menuSlot, 1, ContainerInput.THROW, player);
            } else {
                for (int index = 0; index < count; index++) client.gameMode.handleContainerInput(player.inventoryMenu.containerId, menuSlot, 0, ContainerInput.THROW, player);
            }
            discardedStacks++;
            discardedItems += count;
        }
        boolean retreat = false;
        for (int attempt = 0; attempt < 12 && !retreat; attempt++) {
            double angle = Math.random() * Math.PI * 2;
            double targetX = player.getX() + Math.cos(angle) * 5.0D;
            double targetZ = player.getZ() + Math.sin(angle) * 5.0D;
            retreat = setMovement(new MovementTarget(null, targetX, player.getY(), targetZ, false, 1.2), player);
        }
        return new ActionResult(true, "discarded_stacks=" + discardedStacks + "; discarded_items=" + discardedItems + "; skipped_valuable=" + skippedValuable + "; retreat_engaged=" + retreat);
    }

    private ActionResult discardWornTools(Minecraft client, LocalPlayer player, JsonObject action) {
        if (client.gameMode == null || player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
            return new ActionResult(false, "normal inventory with empty cursor is required");
        }
        int threshold = Math.max(0, Math.min(16, (int) number(action, "remainingDurability", 1)));
        int discardedStacks = 0;
        int discardedItems = 0;
        String authorizedPlayer = action.has("authorizedPlayer") && !action.get("authorizedPlayer").isJsonNull() ? action.get("authorizedPlayer").getAsString() : null;
        for (int slot = 0; slot < player.getInventory().getNonEquipmentItems().size(); slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (stack.isEmpty() || !stack.isDamageableItem() || stack.getMaxDamage() <= 0) continue;
            if (!stack.has(DataComponents.TOOL) && !stack.has(DataComponents.WEAPON)) continue;
            if (!stack.getEnchantments().isEmpty()) continue;
            if (InventoryCleanup.isValuable(stack) && authorizedPlayer != null && !authorizedPlayer.equalsIgnoreCase(ownerName)) continue;
            int remaining = stack.getMaxDamage() - stack.getDamageValue();
            if (remaining > threshold) continue;
            int menuSlot = slot < 9 ? InventoryMenu.USE_ROW_SLOT_START + slot : slot;
            int count = stack.getCount();
            client.gameMode.handleContainerInput(player.inventoryMenu.containerId, menuSlot, 1, ContainerInput.THROW, player);
            discardedStacks++;
            discardedItems += count;
        }
        return new ActionResult(true, "worn_tool_cleanup_confirmed; threshold=" + threshold
            + "; discarded_stacks=" + discardedStacks + "; discarded_items=" + discardedItems);
    }

    private ActionResult startGesture(JsonObject action) {
        String gesture = string(action, "gesture").trim().toLowerCase(Locale.ROOT);
        if (!Set.of("acknowledge", "happy", "afraid", "angry", "excited").contains(gesture)) {
            return new ActionResult(false, "unsupported gesture");
        }
        activeGesture = gesture;
        gestureStartedTick = tick;
        gestureTargetName = action.has("target") && !action.get("target").isJsonNull() ? action.get("target").getAsString() : null;
        gestureCircleStep = 0;
        return new ActionResult(true, "gesture_started=" + gesture);
    }

    private void tickGesture(Minecraft client) {
        if (activeGesture.isEmpty()) return;
        LocalPlayer player = client.player;
        if (player == null || client.level == null) { releaseGesture(client); return; }
        int elapsed = tick - gestureStartedTick;
        int duration = switch (activeGesture) {
            case "afraid" -> 30;
            case "excited" -> 200;
            case "angry" -> 16;
            default -> 20;
        };
        if (elapsed >= duration) { releaseGesture(client); return; }
        switch (activeGesture) {
            case "acknowledge" -> client.options.keyShift.setDown((elapsed >= 1 && elapsed <= 4) || (elapsed >= 9 && elapsed <= 12));
            case "happy" -> {
                // 高兴：边跑边跳
                client.options.keySprint.setDown(true);
                client.options.keyJump.setDown(elapsed % 8 <= 2);
            }
            case "afraid" -> {
                client.options.keySprint.setDown(true);
                client.options.keyJump.setDown(elapsed % 9 <= 3);
            }
            case "angry" -> tickAngryGesture(client, player, elapsed);
            case "excited" -> tickExcitedGesture(client, player, elapsed);
            default -> releaseGesture(client);
        }
    }

    private void tickAngryGesture(Minecraft client, LocalPlayer player, int elapsed) {
        AbstractClientPlayer target = resolveGestureTarget(client, player);
        if (target == null) { releaseGesture(client); return; }
        if (elapsed >= 1 && elapsed <= 5) client.options.keyUp.setDown(true);
        if (elapsed == 6) selectEmptyHand(client, player);
        if (elapsed == 9 && player.distanceToSqr(target) <= 9.0D) {
            client.gameMode.attack(player, target);
            player.swing(InteractionHand.MAIN_HAND);
        }
    }

    private void tickExcitedGesture(Minecraft client, LocalPlayer player, int elapsed) {
        AbstractClientPlayer target = resolveGestureTarget(client, player);
        if (target == null) { releaseGesture(client); return; }
        if (elapsed % 20 == 0) gestureCircleStep++;
        double angle = gestureCircleStep * (Math.PI / 2.0D);
        double radius = 2.5D;
        double cx = target.getX() + Math.cos(angle) * radius;
        double cz = target.getZ() + Math.sin(angle) * radius;
        movementNavigator.drive(client, player, new Vec3(cx, target.getY(), cz), 1.1D, true, tick);
    }

    private AbstractClientPlayer resolveGestureTarget(Minecraft client, LocalPlayer player) {
        if (gestureTargetName != null && !gestureTargetName.isBlank()) {
            AbstractClientPlayer named = findPlayer(client, gestureTargetName);
            if (named != null) return named;
        }
        AbstractClientPlayer nearest = null;
        double nearestDistance = Double.POSITIVE_INFINITY;
        for (AbstractClientPlayer candidate : client.level.players()) {
            if (candidate == player) continue;
            double distance = candidate.distanceToSqr(player);
            if (distance < nearestDistance) { nearestDistance = distance; nearest = candidate; }
        }
        return nearest;
    }

    private void releaseGesture(Minecraft client) {
        client.options.keyShift.setDown(false);
        client.options.keyJump.setDown(false);
        client.options.keySprint.setDown(false);
        client.options.keyUp.setDown(false);
        client.options.keyLeft.setDown(false);
        client.options.keyRight.setDown(false);
        movementNavigator.release(client);
        activeGesture = "";
        gestureTargetName = null;
        gestureCircleStep = 0;
    }

    private static void selectEmptyHand(Minecraft client, LocalPlayer player) {
        for (int slot = 0; slot < 9; slot++) {
            if (player.getInventory().getItem(slot).isEmpty()) {
                if (player.getInventory().getSelectedSlot() != slot) {
                    player.getInventory().setSelectedSlot(slot);
                    player.connection.send(new ServerboundSetCarriedItemPacket(slot));
                }
                return;
            }
        }
    }

    private void updateMovement(Minecraft client, LocalPlayer player) {
        if (movement == null) return;
        MovementTarget target = movement;
        if (target.playerName() != null) {
            AbstractClientPlayer targetPlayer = findPlayer(client, target.playerName());
            if (targetPlayer == null) {
                if (followTargetMissingSince < 0) followTargetMissingSince = tick;
                if (target.follow() && tick - followTargetMissingSince <= 240) {
                    if (followPortal == null || !client.level.isLoaded(followPortal)
                        || !isPortal(client.level.getBlockState(followPortal))) {
                        followPortal = nearestFollowPortal(client, player, new Vec3(target.x(), target.y(), target.z()));
                    }
                    if (followPortal != null) {
                        Vec3 portalGoal = Vec3.atCenterOf(followPortal);
                        target = new MovementTarget(target.playerName(), portalGoal.x, followPortal.getY(), portalGoal.z, true, 0.22D);
                        movement = target;
                    }
                }
                if (!target.playerName().equalsIgnoreCase(ownerName)) {
                    // 被跟随的玩家可能在区块边缘短暂离开已加载的实体集合。
                    // 保留持久跟随模式与最后确认的坐标，而不是悄悄中断跟随。
                    // 继续朝该坐标前进；一旦到达，正常的停止距离分支会在重试可见性期间
                    // 安全等待。
                }
                double segmentDistance = Math.sqrt(
                    Math.pow(target.x() - player.getX(), 2.0D) + Math.pow(target.z() - player.getZ(), 2.0D)
                );
                if (followPortal == null && (segmentDistance <= 3.0D || tick % 40 == 0)) {
                    OwnerLocator.Fix fix = OwnerLocator.locate(client, player, ownerName);
                    if (fix == null) {
                        if (segmentDistance <= 3.0D) {
                            movementNavigator.release(client);
                            traversalRecovery.reset(client);
                            clearMovement(client);
                            if (!target.follow()) movement = null;
                            return;
                        }
                        // 一次短暂的定位器未命中不应让长距离跟随陷入停滞。
                        // 先走完最后确认的路段，然后等待并在上方重试。
                    } else {
                        Vec3 goal = fix.segmentGoal(player, 22.0D);
                        target = new MovementTarget(target.playerName(), goal.x, goal.y, goal.z, target.follow(), target.stopDistance());
                        movement = target;
                    }
                }
            } else {
                followPortal = null;
                followTargetMissingSince = -1;
                target = new MovementTarget(target.playerName(), targetPlayer.getX(), targetPlayer.getY(), targetPlayer.getZ(), target.follow(), target.stopDistance());
                movement = target;
            }
        }
        double dx = target.x() - player.getX();
        double dz = target.z() - player.getZ();
        double distance = Math.sqrt(dx * dx + dz * dz);
        if (target.playerName() == null && target.follow()) {
            if (distance + 0.75D < movementBestDistance) {
                movementBestDistance = distance;
                movementLastProgressTick = tick;
            }
            long withoutProgress = tick - movementLastProgressTick;
            if (withoutProgress >= 400L && !traversalRecovery.active()
                && traversalRecovery.tick(client, player, new Vec3(target.x(), target.y(), target.z()), 8, tick)) {
                movementNavigator.release(client);
                clearMovement(client);
                return;
            }
            if (withoutProgress >= 1_200L) {
                movement = null;
                movementNavigator.release(client);
                traversalRecovery.reset(client);
                clearMovement(client);
                movementTerminalStatus = "home_route_stalled_safe_wait; best_distance="
                    + Math.round(movementBestDistance * 10.0D) / 10.0D
                    + "; no_progress_ticks=" + withoutProgress;
                return;
            }
        }
        if (distance <= target.stopDistance()) {
            clearMovement(client);
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            if (!target.follow()) movement = null;
            return;
        }
        if (traversalRecovery.active()) {
            movementNavigator.release(client);
            if (traversalRecovery.tick(client, player, new Vec3(target.x(), target.y(), target.z()), 8, tick)) {
                clearMovement(client);
                return;
            }
        }
        boolean routed = movementNavigator.drive(
            client,
            player,
            new Vec3(target.x(), target.y(), target.z()),
            target.stopDistance(),
            target.follow() ? distance > target.stopDistance() + 0.6D : distance > 6.0D,
            tick
        );
        if (!routed && movementNavigator.consecutivePlanFailures() >= 8
            && traversalRecovery.tick(client, player, new Vec3(target.x(), target.y(), target.z()), movementNavigator.consecutivePlanFailures(), tick)) {
            movementNavigator.release(client);
            clearMovement(client);
            return;
        }
        if (!routed && movementNavigator.consecutivePlanFailures() >= 20 && !target.follow()) {
            movement = null;
            movementNavigator.release(client);
            traversalRecovery.reset(client);
            clearMovement(client);
        }
    }

    private boolean setMovement(MovementTarget target, LocalPlayer player) {
        movement = target;
        movementTerminalStatus = "";
        movementNavigator.release(Minecraft.getInstance());
        traversalRecovery.reset(Minecraft.getInstance());
        double dx = target.x() - player.getX();
        double dz = target.z() - player.getZ();
        double distance = Math.sqrt(dx * dx + dz * dz);
        movementBestDistance = distance;
        movementLastProgressTick = tick;
        boolean routed = movementNavigator.drive(
            Minecraft.getInstance(), player, new Vec3(target.x(), target.y(), target.z()),
            target.stopDistance(), distance > 6.0D, tick
        );
        if (!routed && !target.follow()) movement = null;
        return routed || target.follow();
    }

    private static void clearMovement(Minecraft client) {
        client.options.keyUp.setDown(false);
        client.options.keyDown.setDown(false);
        client.options.keyLeft.setDown(false);
        client.options.keyRight.setDown(false);
        client.options.keyJump.setDown(false);
        client.options.keySprint.setDown(false);
        client.options.keyShift.setDown(false);
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

    private static BlockPos nearestFollowPortal(Minecraft client, LocalPlayer player, Vec3 lastTarget) {
        if (client.level == null) return null;
        BlockPos origin = player.blockPosition();
        BlockPos best = null;
        double bestDistance = Double.POSITIVE_INFINITY;
        for (BlockPos cursor : BlockPos.betweenClosed(origin.offset(-12, -8, -12), origin.offset(12, 8, 12))) {
            if (!client.level.isLoaded(cursor) || !isPortal(client.level.getBlockState(cursor))) continue;
            if (Vec3.atCenterOf(cursor).distanceToSqr(lastTarget) > 64.0D) continue;
            double distance = player.distanceToSqr(Vec3.atCenterOf(cursor));
            if (distance < bestDistance) { best = cursor.immutable(); bestDistance = distance; }
        }
        return best;
    }

    private static boolean isPortal(BlockState state) {
        return state.is(Blocks.NETHER_PORTAL) || state.is(Blocks.END_PORTAL);
    }

    private JsonObject buildState(Minecraft client, LocalPlayer player) {
        JsonObject event = worldStateEncoder.encode(client, autonomyEnabled || pendingSurvivalAction != null ? survival : null);
        event.addProperty("type", "state");
        event.addProperty("activePrimitive", activeTaskType());
        event.addProperty("navigationStatus", !shelter.activeType().isEmpty()
            ? shelter.navigationStatus()
            : !primitives.activeType().isEmpty()
                ? primitives.navigationStatus()
                : !advanced.activeType().isEmpty()
                    ? advanced.navigationStatus()
                : movement == null
                    ? movementTerminalStatus.isEmpty() ? "idle" : movementTerminalStatus
                    : traversalRecovery.active() ? traversalRecovery.status() : movementNavigator.status());
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
            homeState.addProperty("source", "registered_shelter");
            event.add("home", homeState);
        } else if (firstHomeEnabled) {
            JsonObject homeState = new JsonObject();
            homeState.addProperty("dimension", firstHomeDimension);
            homeState.addProperty("x", firstHomeX);
            homeState.addProperty("y", firstHomeY);
            homeState.addProperty("z", firstHomeZ);
            homeState.addProperty("radius", firstHomeRadius);
            homeState.addProperty("source", "first_home");
            homeState.addProperty("persisted", true);
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
            nearby.addProperty("health", candidate.getHealth());
            JsonObject candidatePosition = new JsonObject();
            candidatePosition.addProperty("x", candidate.getX());
            candidatePosition.addProperty("y", candidate.getY());
            candidatePosition.addProperty("z", candidate.getZ());
            nearby.add("position", candidatePosition);
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
    private record PendingSurvivalAction(
        String id,
        String type,
        int startedTick,
        long baseline,
        int baselineFood,
        float baselineHealth
    ) { }
    private record PendingNavigation(String id, double x, double y, double z, double stopDistance, int startedTick) { }
    private record PendingStepOn(String id, BlockPos block, int startedTick) { }
}
