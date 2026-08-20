package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.TorchBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
  * 由 tick 驱动的庇护所建造与保守的庇护所寻找。
  *
  * <p>该控制器从不直接修改世界方块或物品堆。建造使用正常的多人游戏 {@code useItemOn}
  * 路径，并且只有在预期的服务器同步方块状态在多个客户端 tick 内保持可见后，
  * 才视为放置完成。</p>
  */
public final class ShelterController {
    private static final int HOME_FORMAT_VERSION = 1;
    private static final long MAX_HOME_FILE_BYTES = 16_384L;
    private static final int DEFAULT_BUILD_RADIUS = 5;
    private static final int DEFAULT_BUILD_BUDGET = 64;
    private static final int DEFAULT_BUILD_TIMEOUT_TICKS = 2_400;
    private static final int DEFAULT_SEEK_RADIUS = 24;
    private static final int DEFAULT_SEEK_TIMEOUT_TICKS = 1_200;
    private static final int INVENTORY_CONFIRM_TICKS = 40;
    private static final int PLACEMENT_CONFIRM_TICKS = 4;
    private static final int PLACEMENT_TIMEOUT_TICKS = 60;
    private static final int MOVE_STUCK_TICKS = 80;
    private static final double ARRIVAL_DISTANCE = 0.72D;
    private static final double ENEMY_CLEAR_RADIUS = 8.0D;
    private static final double DEFAULT_MINIMUM_PLAYER_DISTANCE = 48.0D;
    private static final Pattern DIMENSION_PATTERN = Pattern.compile("[a-z0-9_.-]+:[a-z0-9/._-]+");
    private static final List<Direction> HORIZONTAL_DIRECTIONS = List.of(
        Direction.NORTH,
        Direction.SOUTH,
        Direction.WEST,
        Direction.EAST
    );

    public record TaskResult(String id, boolean ok, String detail) { }

    public record ApprovedZone(String dimension, BlockPos min, BlockPos max) {
        public ApprovedZone {
            if (dimension == null || dimension.isBlank()) throw new IllegalArgumentException("dimension is required");
            if (min == null || max == null) throw new IllegalArgumentException("zone bounds are required");
            int minX = Math.min(min.getX(), max.getX());
            int minY = Math.min(min.getY(), max.getY());
            int minZ = Math.min(min.getZ(), max.getZ());
            int maxX = Math.max(min.getX(), max.getX());
            int maxY = Math.max(min.getY(), max.getY());
            int maxZ = Math.max(min.getZ(), max.getZ());
            min = new BlockPos(minX, minY, minZ);
            max = new BlockPos(maxX, maxY, maxZ);
            dimension = dimension.trim();
        }

        public boolean contains(BlockPos position) {
            return position != null
                && position.getX() >= min.getX() && position.getX() <= max.getX()
                && position.getY() >= min.getY() && position.getY() <= max.getY()
                && position.getZ() >= min.getZ() && position.getZ() <= max.getZ();
        }
    }

    /** 记忆中的庇护所入口与内部的防御性、类拷贝不可变快照。 */
    public record HomeSnapshot(
        String dimension,
        BlockPos position,
        BlockPos door,
        long updatedAtEpochMs,
        boolean persisted
    ) {
        public HomeSnapshot {
            if (dimension == null || dimension.isBlank()) throw new IllegalArgumentException("dimension is required");
            if (position == null || door == null) throw new IllegalArgumentException("home coordinates are required");
            dimension = dimension.trim();
            position = position.immutable();
            door = door.immutable();
        }
    }

    private record HomeStorage(Path file, boolean configured, HomeSnapshot loaded, String issue) { }

    private record BuildSite(
        BlockPos home,
        BlockPos door,
        Direction doorDirection,
        List<BlockPos> targets
    ) {
        BuildSite {
            home = home.immutable();
            door = door.immutable();
            targets = List.copyOf(targets);
        }
    }

    private record MaterialChoice(BlockItem item, Block block, int totalCount, double score) { }

    private record FixtureChoice(BlockItem item, Block block) { }

    private enum PlacementKind { DOOR, LIGHT, SHELL }

    private record PlacementSpec(PlacementKind kind, BlockPos target, BlockItem item, Block block) { }

    private record PlacementSupport(BlockPos position, Direction face, BlockHitResult hit) { }

    private record NearbyPlayer(String name, double distance) { }

    private record ShelterTarget(TargetKind kind, BlockPos goal, BlockPos interaction, List<BlockPos> waypoints) {
        ShelterTarget {
            goal = goal.immutable();
            interaction = interaction == null ? null : interaction.immutable();
            waypoints = List.copyOf(waypoints);
        }
    }

    private enum TargetKind { HOME, BED, SAFE_POSITION }

    private enum MovementOutcome { MOVING, ARRIVED, BLOCKED }

    private enum MaterialStatus { READY, WAITING, MISSING, INVALID_MENU }

    private final ArrayDeque<TaskResult> results = new ArrayDeque<>();
    private final LocalPathNavigator navigator = new LocalPathNavigator();
    private final Path homeFile;
    private final boolean homePersistenceConfigured;
    private String persistenceIssue;
    private ApprovedZone approvedZone;
    private HomeSnapshot home;
    private ShelterTask active;
    private int taskInitialSelectedSlot = -1;
    private long tick;
    private double minimumPlayerDistance = DEFAULT_MINIMUM_PLAYER_DISTANCE;

    public ShelterController() {
        HomeStorage storage = loadHomeStorage();
        homeFile = storage.file();
        homePersistenceConfigured = storage.configured();
        home = storage.loaded();
        persistenceIssue = storage.issue();
    }

    /** 在没有其他庇护所动作处于活动状态时，接受一个受支持的庇护所动作。 */
    public boolean start(String id, JsonObject action, Minecraft client) {
        if (id == null || id.isBlank()) return false;
        if (active != null) {
            results.add(new TaskResult(id, false, "busy: active shelter task is " + active.type));
            return false;
        }
        if (!inWorld(client)) {
            results.add(new TaskResult(id, false, "not_in_world"));
            return false;
        }
        if (action == null || !action.has("type") || !action.get("type").isJsonPrimitive()) {
            results.add(new TaskResult(id, false, "invalid_action: missing type"));
            return false;
        }

        String type = action.get("type").getAsString().trim().toLowerCase(Locale.ROOT);
        ShelterTask task;
        try {
            task = switch (type) {
                case "build_shelter" -> createBuildTask(id, action, client);
                case "seek_shelter" -> createSeekTask(id, action, client);
                default -> null;
            };
        } catch (Exception error) {
            results.add(new TaskResult(id, false, "invalid_action: " + safeMessage(error)));
            return false;
        }
        if (task == null) {
            if (!type.equals("build_shelter") && !type.equals("seek_shelter")) {
                results.add(new TaskResult(id, false, "unsupported shelter action: " + type));
            }
            return false;
        }
        active = task;
        taskInitialSelectedSlot = client.player != null ? client.player.getInventory().getSelectedSlot() : -1;
        return true;
    }

    /** 在 Minecraft 客户端线程上推进活动庇护所任务一次。 */
    public void tick(Minecraft client) {
        tick++;
        ShelterTask task = active;
        if (task == null) return;
        if (!inWorld(client)) {
            finish(client, task, false, "not_in_world");
            return;
        }
        if (tick - task.startedTick > task.timeoutTicks) {
            finish(client, task, false, "timeout: " + task.type + task.progressSuffix());
            return;
        }
        try {
            task.tick(client);
        } catch (Exception error) {
            finish(client, task, false, "exception: " + error.getClass().getSimpleName() + ": " + safeMessage(error));
        }
    }

    public boolean cancel(Minecraft client) {
        return cancel(client, "cancelled");
    }

    public boolean cancel(Minecraft client, String detail) {
        ShelterTask task = active;
        if (task == null) return false;
        String reason = detail == null || detail.isBlank() ? "cancelled" : detail.trim();
        finish(client, task, false, reason + task.progressSuffix());
        return true;
    }

    /** 返回并清空所有终态结果。 */
    public List<TaskResult> drainResults() {
        List<TaskResult> drained = new ArrayList<>(results);
        results.clear();
        return drained;
    }

    /** 空闲时返回空字符串。 */
    public String activeType() {
        return active == null ? "" : active.type;
    }

    public String navigationStatus() {
        return navigator.status();
    }

    public void setApprovedZone(String dimension, BlockPos min, BlockPos max) {
        approvedZone = new ApprovedZone(dimension, min, max);
    }

    public void clearApprovedZone() {
        approvedZone = null;
    }

    public ApprovedZone approvedZone() {
        return approvedZone;
    }

    /** 返回已加载或新建的家；当没有有效记录时返回 {@code null}。 */
    public HomeSnapshot homeSnapshot() {
        return home;
    }

    /**
      * 设置仅由 {@code build_shelter} 使用的荒野排除半径。
      * 数值会被保守地限制在 8..512 格范围内，以使该安全边界无法被禁用。
      */
    public void setMinimumPlayerDistance(double distance) {
        if (!Double.isFinite(distance)) throw new IllegalArgumentException("minimum player distance must be finite");
        minimumPlayerDistance = Math.max(8.0D, Math.min(512.0D, distance));
    }

    public double minimumPlayerDistance() {
        return minimumPlayerDistance;
    }

    private BuildTask createBuildTask(String id, JsonObject action, Minecraft client) {
        ApprovedZone zone = approvedZone;
        if (zone == null) {
            boolean verifiedWilderness = action.has("verifiedWilderness")
                && action.get("verifiedWilderness").isJsonPrimitive()
                && action.get("verifiedWilderness").getAsBoolean();
            WildernessGuard.Assessment assessment = WildernessGuard.assess(
                client, client.player.blockPosition(), WildernessGuard.DEFAULT_SCAN_RADIUS,
                minimumPlayerDistance, null
            );
            if (!verifiedWilderness || !assessment.allowed()) {
                results.add(new TaskResult(id, false, "refused: build_shelter requires verified dynamic wilderness: "
                    + String.join(",", assessment.reasons())));
                return null;
            }
            PrimitiveTaskController.ApprovedZone workZone = WildernessGuard.workZone(client, client.player.blockPosition(), 8, 8);
            zone = new ApprovedZone(workZone.dimension(), workZone.min(), workZone.max());
        }
        String dimension = dimensionId(client);
        if (!zone.dimension().equals(dimension)) {
            results.add(new TaskResult(id, false, "refused: verified shelter work window belongs to another dimension"));
            return null;
        }
        LocalPlayer player = client.player;
        if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
            results.add(new TaskResult(id, false, "build_shelter requires the normal inventory with an empty cursor"));
            return null;
        }
        NearbyPlayer nearby = nearestOtherPlayer(client, player.position(), minimumPlayerDistance);
        if (nearby != null) {
            results.add(new TaskResult(id, false, "refused: wilderness build requires every other player to be at least "
                + formatDistance(minimumPlayerDistance) + " blocks away; nearest=" + nearby.name()
                + " at " + formatDistance(nearby.distance()) + " blocks"));
            return null;
        }

        int radius = integer(action, "radius", 2, 8, DEFAULT_BUILD_RADIUS);
        int blockBudget = integer(action, "blockBudget", 1, 128, DEFAULT_BUILD_BUDGET);
        int timeout = integer(action, "timeoutTicks", 400, 6_000, DEFAULT_BUILD_TIMEOUT_TICKS);
        BuildSite site = findBuildSite(client, player, zone, radius);
        if (site == null) {
            results.add(new TaskResult(id, false,
                "no safe flat 3x3 build site found in the verified work window without replacing protected blocks"));
            return null;
        }
        int requiredWorldBlocks = site.targets().size() + 3; // 一扇两格高的门和一支火把
        if (requiredWorldBlocks > blockBudget) {
            results.add(new TaskResult(id, false, "block budget " + blockBudget
                + " is below the verified safe-shelter requirement " + requiredWorldBlocks));
            return null;
        }
        FixtureChoice door = chooseUsableDoor(player);
        if (door == null) {
            results.add(new TaskResult(id, false,
                "missing a hand-openable door item; refusing to start an unsafe open-doorway shell"));
            return null;
        }
        FixtureChoice light = chooseSafeLight(player);
        if (light == null) {
            results.add(new TaskResult(id, false,
                "missing a normal torch; refusing to start a spawnable dark shelter"));
            return null;
        }
        MaterialChoice material = chooseMaterial(client, player, site.targets().size());
        if (material == null) {
            results.add(new TaskResult(id, false, "missing enough suitable ordinary full blocks; required="
                + site.targets().size()));
            return null;
        }
        return new BuildTask(
            id,
            zone,
            dimension,
            site,
            material,
            door,
            light,
            blockBudget,
            minimumPlayerDistance,
            timeout,
            tick
        );
    }

    private SeekTask createSeekTask(String id, JsonObject action, Minecraft client) {
        int radius = integer(action, "radius", 4, 32, DEFAULT_SEEK_RADIUS);
        int timeout = integer(action, "timeoutTicks", 200, 4_000, DEFAULT_SEEK_TIMEOUT_TICKS);
        ShelterTarget target = chooseShelterTarget(client, client.player, radius);
        if (target == null) {
            String remembered = home == null ? "none" : "recorded home is unavailable, unsafe, or in another dimension";
            results.add(new TaskResult(id, false, "no measured safe shelter target within radius=" + radius
                + "; home=" + remembered));
            return null;
        }
        return new SeekTask(id, dimensionId(client), target, timeout, tick);
    }

    private abstract class ShelterTask {
        final String id;
        final String type;
        final long startedTick;
        final int timeoutTicks;

        ShelterTask(String id, String type, long startedTick, int timeoutTicks) {
            this.id = id;
            this.type = type;
            this.startedTick = startedTick;
            this.timeoutTicks = timeoutTicks;
        }

        abstract void tick(Minecraft client);

        String progressSuffix() {
            return "";
        }
    }

    private final class BuildTask extends ShelterTask {
        private enum Phase { MOVE_INSIDE, PREPARE, CROUCH_READY, VERIFY }

        private final ApprovedZone zone;
        private final String dimension;
        private final BuildSite site;
        private final MaterialChoice material;
        private final FixtureChoice door;
        private final FixtureChoice light;
        private final int blockBudget;
        private final double wildernessDistance;
        private Phase phase = Phase.MOVE_INSIDE;
        private int fixtureStep;
        private int targetIndex;
        private int verifiedPlacements;
        private int placementAttempts;
        private int stableTicks;
        private long phaseStartedTick;
        private long inventoryRequestTick = -1L;
        private Vec3 lastProgressPosition;
        private long lastProgressTick;
        private PlacementSupport support;
        private PlacementSpec currentPlacement;
        private String lastInteraction = "not_sent";

        BuildTask(
            String id,
            ApprovedZone zone,
            String dimension,
            BuildSite site,
            MaterialChoice material,
            FixtureChoice door,
            FixtureChoice light,
            int blockBudget,
            double wildernessDistance,
            int timeoutTicks,
            long startedTick
        ) {
            super(id, "build_shelter", startedTick, timeoutTicks);
            this.zone = zone;
            this.dimension = dimension;
            this.site = site;
            this.material = material;
            this.door = door;
            this.light = light;
            this.blockBudget = blockBudget;
            this.wildernessDistance = wildernessDistance;
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (!dimension.equals(dimensionId(client))) {
                finish(client, this, false, "dimension changed while building" + progressSuffix());
                return;
            }
            if (!allTargetsInside(site.targets(), zone)
                || !zone.contains(site.home()) || !zone.contains(site.home().above(2))
                || !zone.contains(site.door()) || !zone.contains(site.door().above())) {
                finish(client, this, false, "shelter plan escaped its verified work window" + progressSuffix());
                return;
            }
            if (client.level.hasNeighborSignal(site.door())
                || client.level.hasNeighborSignal(site.door().above())) {
                finish(client, this, false, "door site became redstone-powered; refusing an unclosable shelter"
                    + progressSuffix());
                return;
            }
            NearbyPlayer nearby = nearestOtherPlayer(client, Vec3.atCenterOf(site.home()), wildernessDistance);
            if (nearby != null) {
                finish(client, this, false, "another player entered the wilderness exclusion radius: "
                    + nearby.name() + " at " + formatDistance(nearby.distance()) + " blocks" + progressSuffix());
                return;
            }
            if (hasEnemyNear(client, player, site.home(), ENEMY_CLEAR_RADIUS)) {
                finish(client, this, false, "enemy entered construction safety radius" + progressSuffix());
                return;
            }

            if (phase == Phase.MOVE_INSIDE) {
                MovementOutcome outcome = moveConservatively(client, player, site.home());
                if (outcome == MovementOutcome.ARRIVED) {
                    clearMovement(client);
                    if (!isPhysicalStandPosition(client, player, site.home())) {
                        finish(client, this, false, "planned interior is no longer standable" + progressSuffix());
                        return;
                    }
                    phase = Phase.PREPARE;
                    lastProgressPosition = null;
                    return;
                }
                if (outcome == MovementOutcome.BLOCKED) {
                    finish(client, this, false, "no collision-safe loaded route to shelter interior" + progressSuffix());
                    return;
                }
                checkMovementProgress(client, player, this, site.home());
                return;
            }

            if (phase == Phase.VERIFY) {
                verifyPlacement(client);
                return;
            }

            if (!arrived(player, site.home())) {
                client.options.keyShift.setDown(false);
                phase = Phase.MOVE_INSIDE;
                return;
            }
            clearMovement(client);

            PlacementSpec placement = nextPlacement();
            if (placement == null) {
                completeShelter(client);
                return;
            }
            int placementCost = placement.kind() == PlacementKind.DOOR ? 2 : 1;
            if (verifiedPlacements + placementCost > blockBudget) {
                finish(client, this, false, "placement budget exhausted" + progressSuffix());
                return;
            }

            BlockPos target = placement.target();
            BlockState before = client.level.getBlockState(target);
            if (!zone.contains(target) || !client.level.isLoaded(target)) {
                finish(client, this, false, "target unavailable or outside the verified work window: " + target + progressSuffix());
                return;
            }
            if (!before.canBeReplaced() || client.level.getBlockEntity(target) != null) {
                finish(client, this, false, "target changed to protected/non-replaceable state: " + target
                    + progressSuffix());
                return;
            }
            if (placement.kind() == PlacementKind.DOOR
                && !replaceableWithoutBlockEntity(client, target.above())) {
                finish(client, this, false, "door upper half changed to protected/non-replaceable state: "
                    + target.above() + progressSuffix());
                return;
            }

            MaterialStatus materialStatus = prepareSelectedItem(client, player, this, placement.item());
            if (materialStatus == MaterialStatus.WAITING) return;
            if (materialStatus == MaterialStatus.MISSING) {
                finish(client, this, false, "building material ran out before target " + target + progressSuffix());
                return;
            }
            if (materialStatus == MaterialStatus.INVALID_MENU) {
                finish(client, this, false, "inventory changed while preparing building material" + progressSuffix());
                return;
            }

            support = findPlacementSupport(client, player, target, placement.item(), placement.block());
            if (support == null) {
                finish(client, this, false, "no legal reachable support face for target " + target + progressSuffix());
                return;
            }
            if (!player.isWithinBlockInteractionRange(support.position(), 0.0D)) {
                finish(client, this, false, "support face is outside legal interaction range for target " + target
                    + progressSuffix());
                return;
            }

            lookAt(player, support.hit().getLocation());
            client.options.keyShift.setDown(true);
            if (phase != Phase.CROUCH_READY) {
                phase = Phase.CROUCH_READY;
                phaseStartedTick = tick;
                return;
            }
            if (tick <= phaseStartedTick) return;

            ItemStack selected = player.getInventory().getSelectedItem();
            if (selected.isEmpty() || selected.getItem() != placement.item()) {
                phase = Phase.PREPARE;
                client.options.keyShift.setDown(false);
                return;
            }
            BlockPlaceContext rawContext = new BlockPlaceContext(
                player,
                InteractionHand.MAIN_HAND,
                selected,
                support.hit()
            );
            BlockPlaceContext placementContext = placement.item().updatePlacementContext(rawContext);
            if (placementContext == null || !placementContext.canPlace()
                || !placementContext.getClickedPos().equals(target)) {
                finish(client, this, false, "BlockItem rejected placement context for " + target + progressSuffix());
                return;
            }
            BlockState predicted = placement.block().getStateForPlacement(placementContext);
            if (predicted == null || !predicted.canSurvive(client.level, target)
                || !client.level.isUnobstructed(predicted, target, CollisionContext.placementContext(player))) {
                finish(client, this, false, "predicted block cannot safely survive unobstructed at " + target
                    + progressSuffix());
                return;
            }
            if (!player.mayUseItemAt(support.position(), support.face(), selected)) {
                finish(client, this, false, "server permissions disallow placement at " + target + progressSuffix());
                return;
            }

            InteractionResult interaction = client.gameMode.useItemOn(
                player,
                InteractionHand.MAIN_HAND,
                support.hit()
            );
            lastInteraction = interaction.getClass().getSimpleName();
            placementAttempts++;
            if (!interaction.consumesAction()) {
                finish(client, this, false, "placement interaction was rejected: " + lastInteraction
                    + "; target=" + target + progressSuffix());
                return;
            }
            player.swing(InteractionHand.MAIN_HAND);
            currentPlacement = placement;
            phase = Phase.VERIFY;
            phaseStartedTick = tick;
            stableTicks = 0;
        }

        private void verifyPlacement(Minecraft client) {
            PlacementSpec placement = currentPlacement;
            if (placement == null) {
                finish(client, this, false, "internal placement state was lost" + progressSuffix());
                return;
            }
            BlockPos target = placement.target();
            BlockState observed = client.level.getBlockState(target);
            boolean expected = switch (placement.kind()) {
                case DOOR -> verifiedClosedDoor(client, target, placement.block());
                case LIGHT, SHELL -> observed.is(placement.block())
                    && !observed.canBeReplaced()
                    && client.level.getBlockEntity(target) == null;
            };
            if (expected) {
                stableTicks++;
                if (stableTicks >= PLACEMENT_CONFIRM_TICKS) {
                    OwnedBlockRegistry.registerPlacedStructure(client, target, blockId(observed));
                    verifiedPlacements += placement.kind() == PlacementKind.DOOR ? 2 : 1;
                    switch (placement.kind()) {
                        case DOOR, LIGHT -> fixtureStep++;
                        case SHELL -> targetIndex++;
                    }
                    stableTicks = 0;
                    support = null;
                    currentPlacement = null;
                    phase = Phase.PREPARE;
                    phaseStartedTick = tick;
                    client.options.keyShift.setDown(false);
                }
                return;
            }
            stableTicks = 0;
            boolean unexpectedProtected = !observed.canBeReplaced()
                && !(placement.kind() == PlacementKind.DOOR && observed.is(placement.block()));
            if (unexpectedProtected || client.level.getBlockEntity(target) != null) {
                finish(client, this, false, "server reported an unexpected protected block at " + target
                    + "; observed=" + blockId(observed) + progressSuffix());
                return;
            }
            if (tick - phaseStartedTick > PLACEMENT_TIMEOUT_TICKS) {
                // 超时前做最后一次真实回读：服务器可能已放置但客户端同步延迟。
                BlockState finalObserved = client.level.getBlockState(target);
                boolean finalExpected = switch (placement.kind()) {
                    case DOOR -> verifiedClosedDoor(client, target, placement.block());
                    case LIGHT, SHELL -> finalObserved.is(placement.block())
                        && !finalObserved.canBeReplaced()
                        && client.level.getBlockEntity(target) == null;
                };
                if (finalExpected) {
                    OwnedBlockRegistry.registerPlacedStructure(client, target, blockId(finalObserved));
                    verifiedPlacements += placement.kind() == PlacementKind.DOOR ? 2 : 1;
                    switch (placement.kind()) {
                        case DOOR, LIGHT -> fixtureStep++;
                        case SHELL -> targetIndex++;
                    }
                    stableTicks = 0;
                    support = null;
                    currentPlacement = null;
                    phase = Phase.PREPARE;
                    phaseStartedTick = tick;
                    client.options.keyShift.setDown(false);
                    return;
                }
                finish(client, this, false, "server did not confirm placement at " + target
                    + "; interaction=" + lastInteraction + progressSuffix());
            }
        }

        private PlacementSpec nextPlacement() {
            if (fixtureStep == 0) {
                return new PlacementSpec(PlacementKind.DOOR, site.door(), door.item(), door.block());
            }
            if (fixtureStep == 1) {
                return new PlacementSpec(PlacementKind.LIGHT, site.home(), light.item(), light.block());
            }
            if (targetIndex < site.targets().size()) {
                return new PlacementSpec(
                    PlacementKind.SHELL,
                    site.targets().get(targetIndex),
                    material.item(),
                    material.block()
                );
            }
            return null;
        }

        private void completeShelter(Minecraft client) {
            for (BlockPos target : site.targets()) {
                BlockState state = client.level.getBlockState(target);
                if (!state.is(material.block()) || state.canBeReplaced() || client.level.getBlockEntity(target) != null) {
                    finish(client, this, false, "final shelter verification failed at " + target + progressSuffix());
                    return;
                }
            }
            if (!verifiedClosedDoor(client, site.door(), door.block())) {
                finish(client, this, false, "final shelter verification found no closed hand-openable door"
                    + progressSuffix());
                return;
            }
            BlockState lightState = client.level.getBlockState(site.home());
            int blockLight = client.level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, site.home());
            int spawnLimit = client.level.dimensionType().monsterSpawnBlockLightLimit();
            if (!lightState.is(light.block()) || !(lightState.getBlock() instanceof TorchBlock)
                || blockLight <= spawnLimit) {
                finish(client, this, false, "final shelter verification found no safe confirmed torch light; block_light="
                    + blockLight + "; spawn_limit=" + spawnLimit + progressSuffix());
                return;
            }
            if (!isPhysicalStandPosition(client, client.player, site.home())
                || !isSafePosition(client, client.player, site.home())) {
                finish(client, this, false, "structure exists but interior safety postcondition failed"
                    + progressSuffix());
                return;
            }

            HomeSnapshot candidate = new HomeSnapshot(
                dimension,
                site.home(),
                site.door(),
                System.currentTimeMillis(),
                false
            );
            String persistence = persistHome(candidate);
            boolean persisted = persistence == null && homePersistenceConfigured;
            home = new HomeSnapshot(
                candidate.dimension(),
                candidate.position(),
                candidate.door(),
                candidate.updatedAtEpochMs(),
                persisted
            );
            if (persistence != null) {
                finish(client, this, false, "shelter verified and home kept in memory, but MCAI_HOME_FILE write failed: "
                    + persistence + progressSuffix());
                return;
            }
            String storage = persisted ? "atomically persisted" : "memory-only (MCAI_HOME_FILE is not set)";
            finish(client, this, true, "shelter verified; home=" + site.home() + "; door=" + site.door()
                + "; material=" + blockId(material.block()) + "; door_item=" + blockId(door.block())
                + "; light=" + blockId(light.block()) + "; storage=" + storage + progressSuffix());
        }

        @Override
        String progressSuffix() {
            return "; verified_world_blocks=" + verifiedPlacements + "/" + (site.targets().size() + 3)
                + "; attempts=" + placementAttempts + "/" + blockBudget;
        }
    }

    private final class SeekTask extends ShelterTask {
        private enum Phase { MOVE, SETTLE_BED, WAIT_BED }
        private enum HomePhase {
            INITIAL,
            MOVE_OUTSIDE,
            SETTLE_OPEN,
            WAIT_OPEN,
            MOVE_INSIDE,
            SETTLE_CLOSE,
            WAIT_CLOSE
        }

        private final String dimension;
        private ShelterTarget target;
        private Phase phase = Phase.MOVE;
        private HomePhase homePhase = HomePhase.INITIAL;
        private int waypointIndex;
        private int doorStableTicks;
        private Vec3 lastProgressPosition;
        private long lastProgressTick;
        private long phaseStartedTick;
        private String interactionDetail = "not_sent";

        SeekTask(
            String id,
            String dimension,
            ShelterTarget target,
            int timeoutTicks,
            long startedTick
        ) {
            super(id, "seek_shelter", startedTick, timeoutTicks);
            this.dimension = dimension;
            this.target = target;
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (!dimension.equals(dimensionId(client))) {
                finish(client, this, false, "dimension changed while seeking shelter" + progressSuffix());
                return;
            }
            if (player.isSleeping()) {
                finish(client, this, true, "server confirmed sleeping at shelter target" + progressSuffix());
                return;
            }
            if (target.kind() == TargetKind.HOME) {
                tickRecordedHome(client, player);
                return;
            }
            if (phase == Phase.WAIT_BED) {
                // 只有真正睡着才算成功；不再用「位置安全」兜底掩盖未入睡。
                if (tick - phaseStartedTick > 80L) {
                    finish(client, this, false, "server did not confirm sleeping and the bed area is unsafe; interaction="
                        + interactionDetail + progressSuffix());
                }
                return;
            }

            BlockPos waypoint = target.waypoints().get(Math.min(waypointIndex, target.waypoints().size() - 1));
            MovementOutcome outcome = moveConservatively(client, player, waypoint);
            if (outcome == MovementOutcome.BLOCKED) {
                finish(client, this, false, "no collision-safe loaded route to waypoint " + waypoint + progressSuffix());
                return;
            }
            if (outcome == MovementOutcome.MOVING) {
                checkMovementProgress(client, player, this, waypoint);
                return;
            }
            clearMovement(client);
            lastProgressPosition = null;
            if (waypointIndex + 1 < target.waypoints().size()) {
                waypointIndex++;
                return;
            }

            if (target.kind() != TargetKind.BED) {
                if (isSafePosition(client, player, target.goal())) {
                    finish(client, this, true, "measured safe shelter reached; kind="
                        + target.kind().name().toLowerCase(Locale.ROOT) + "; position=" + target.goal());
                } else {
                    finish(client, this, false, "target reached but safety postcondition no longer holds; position="
                        + target.goal());
                }
                return;
            }

            BlockPos bed = target.interaction();
            if (bed == null || !client.level.isLoaded(bed) || !client.level.getBlockState(bed).is(BlockTags.BEDS)) {
                finish(client, this, false, "bed disappeared before interaction" + progressSuffix());
                return;
            }
            if (!client.level.dimension().equals(Level.OVERWORLD)) {
                if (isSafePosition(client, player, target.goal())) {
                    finish(client, this, true, "bed was not touched outside the overworld; adjacent position is measured safe"
                        + progressSuffix());
                } else {
                    finish(client, this, false, "refused dangerous bed interaction outside the overworld; area is unsafe"
                        + progressSuffix());
                }
                return;
            }
            if (!client.level.isDarkOutside()) {
                if (isSafePosition(client, player, target.goal())) {
                    finish(client, this, true, "daytime bed area is measured safe" + progressSuffix());
                } else {
                    finish(client, this, false, "bed interaction is unnecessary before night and area is not safe"
                        + progressSuffix());
                }
                return;
            }
            if (!player.isWithinBlockInteractionRange(bed, 0.0D)) {
                finish(client, this, false, "bed is outside legal interaction range after arrival" + progressSuffix());
                return;
            }
            if (phase != Phase.SETTLE_BED) {
                clearMovement(client);
                phase = Phase.SETTLE_BED;
                phaseStartedTick = tick;
                return;
            }
            if (tick - phaseStartedTick < 2L) return;

            int previousSlot = selectEmptyHand(client, player);
            BlockHitResult hit = new BlockHitResult(Vec3.atCenterOf(bed), Direction.UP, bed, false);
            lookAt(player, hit.getLocation());
            InteractionResult result = client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
            restoreSelectedSlot(player, previousSlot);
            interactionDetail = result.getClass().getSimpleName();
            if (!result.consumesAction()) {
                finish(client, this, false, "bed interaction was rejected: " + interactionDetail + progressSuffix());
                return;
            }
            player.swing(InteractionHand.MAIN_HAND);
            phase = Phase.WAIT_BED;
            phaseStartedTick = tick;
        }

        private int selectEmptyHand(Minecraft client, LocalPlayer player) {
            int previous = player.getInventory().getSelectedSlot();
            for (int slot = 0; slot < 9; slot++) {
                if (player.getInventory().getItem(slot).isEmpty()) {
                    if (slot != previous) {
                        player.getInventory().setSelectedSlot(slot);
                        player.connection.send(new ServerboundSetCarriedItemPacket(slot));
                    }
                    return previous;
                }
            }
            return previous;
        }

        private void restoreSelectedSlot(LocalPlayer player, int slot) {
            if (player.getInventory().getSelectedSlot() != slot) {
                player.getInventory().setSelectedSlot(slot);
                player.connection.send(new ServerboundSetCarriedItemPacket(slot));
            }
        }

        private void fallbackToShelter(Minecraft client, LocalPlayer player) {
            ShelterTarget fallback = findFallbackShelter(client, player, 14);
            if (fallback == null) {
                finish(client, this, false, "recorded home became unsafe and no fallback shelter was found"
                    + progressSuffix());
                return;
            }
            this.target = fallback;
            this.waypointIndex = 0;
            this.homePhase = HomePhase.INITIAL;
            this.phase = Phase.MOVE;
            this.phaseStartedTick = tick;
        }

        private void tickRecordedHome(Minecraft client, LocalPlayer player) {
            BlockPos door = target.interaction();
            if (door == null || !usableHomeDoor(client, door)) {
                fallbackToShelter(client, player);
                return;
            }
            if (hasEnemyNear(client, player, target.goal(), ENEMY_CLEAR_RADIUS)) {
                fallbackToShelter(client, player);
                return;
            }

            if (homePhase == HomePhase.INITIAL) {
                homePhase = arrived(player, target.goal())
                    ? HomePhase.SETTLE_CLOSE
                    : HomePhase.MOVE_OUTSIDE;
                phaseStartedTick = tick;
            }

            if (homePhase == HomePhase.MOVE_OUTSIDE) {
                if (target.waypoints().isEmpty()) {
                finish(client, this, false, "recorded home has no navigation waypoints" + progressSuffix());
                return;
            }
            BlockPos outside = target.waypoints().get(0);
                MovementOutcome outcome = moveConservatively(client, player, outside);
                if (outcome == MovementOutcome.BLOCKED) {
                    finish(client, this, false, "no collision-safe loaded route to recorded home entrance"
                        + progressSuffix());
                    return;
                }
                if (outcome == MovementOutcome.MOVING) {
                    checkMovementProgress(client, player, this, outside);
                    return;
                }
                clearMovement(client);
                lastProgressPosition = null;
                homePhase = HomePhase.SETTLE_OPEN;
                phaseStartedTick = tick;
                return;
            }

            if (homePhase == HomePhase.SETTLE_OPEN) {
                clearMovement(client);
                if (homeDoorFullyOpen(client, door)) {
                    homePhase = HomePhase.MOVE_INSIDE;
                    phaseStartedTick = tick;
                    return;
                }
                if (tick - phaseStartedTick < 2L) return;
                if (!interactRecordedDoor(client, player, door, true)) return;
                homePhase = HomePhase.WAIT_OPEN;
                phaseStartedTick = tick;
                doorStableTicks = 0;
                return;
            }

            if (homePhase == HomePhase.WAIT_OPEN) {
                if (homeDoorFullyOpen(client, door)) {
                    doorStableTicks++;
                    if (doorStableTicks >= 3) {
                        homePhase = HomePhase.MOVE_INSIDE;
                        lastProgressPosition = null;
                    }
                    return;
                }
                doorStableTicks = 0;
                if (tick - phaseStartedTick > PLACEMENT_TIMEOUT_TICKS) {
                    finish(client, this, false, "server did not confirm recorded home door opening; interaction="
                        + interactionDetail + progressSuffix());
                }
                return;
            }

            if (homePhase == HomePhase.MOVE_INSIDE) {
                MovementOutcome outcome = moveConservatively(client, player, target.goal());
                if (outcome == MovementOutcome.BLOCKED) {
                    finish(client, this, false, "open recorded door did not provide a collision-safe path inside"
                        + progressSuffix());
                    return;
                }
                if (outcome == MovementOutcome.MOVING) {
                    checkMovementProgress(client, player, this, target.goal());
                    return;
                }
                clearMovement(client);
                lastProgressPosition = null;
                homePhase = HomePhase.SETTLE_CLOSE;
                phaseStartedTick = tick;
                return;
            }

            if (homePhase == HomePhase.SETTLE_CLOSE) {
                clearMovement(client);
                if (homeDoorFullyClosed(client, door)) {
                    finishRecordedHome(client, player);
                    return;
                }
                if (tick - phaseStartedTick < 2L) return;
                if (doorwayOccupied(client, player, door)) {
                    finish(client, this, false, "refused to close recorded home door while an entity occupies its doorway"
                        + progressSuffix());
                    return;
                }
                if (!interactRecordedDoor(client, player, door, false)) return;
                homePhase = HomePhase.WAIT_CLOSE;
                phaseStartedTick = tick;
                doorStableTicks = 0;
                return;
            }

            if (homePhase == HomePhase.WAIT_CLOSE) {
                if (homeDoorFullyClosed(client, door)) {
                    doorStableTicks++;
                    if (doorStableTicks >= 3) finishRecordedHome(client, player);
                    return;
                }
                doorStableTicks = 0;
                if (tick - phaseStartedTick > PLACEMENT_TIMEOUT_TICKS) {
                    finish(client, this, false, "server did not confirm recorded home door closing; interaction="
                        + interactionDetail + progressSuffix());
                }
            }
        }

        private boolean interactRecordedDoor(
            Minecraft client,
            LocalPlayer player,
            BlockPos door,
            boolean opening
        ) {
            if (!player.isWithinBlockInteractionRange(door, 0.0D)) {
                finish(client, this, false, "recorded home door is outside legal interaction range while "
                    + (opening ? "opening" : "closing") + progressSuffix());
                return false;
            }
            clearMovement(client);
            int previousSlot = selectEmptyHand(client, player);
            BlockHitResult hit = new BlockHitResult(
                Vec3.atCenterOf(door).add(0.0D, 0.5D, 0.0D),
                Direction.UP,
                door,
                false
            );
            lookAt(player, hit.getLocation());
            InteractionResult result = client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
            restoreSelectedSlot(player, previousSlot);
            interactionDetail = result.getClass().getSimpleName();
            if (!result.consumesAction()) {
                finish(client, this, false, "recorded home door interaction was rejected while "
                    + (opening ? "opening" : "closing") + ": " + interactionDetail + progressSuffix());
                return false;
            }
            player.swing(InteractionHand.MAIN_HAND);
            return true;
        }

        private void finishRecordedHome(Minecraft client, LocalPlayer player) {
            if (!arrived(player, target.goal())
                || !homeDoorFullyClosed(client, target.interaction())
                || !recordedHomeEnvironmentValid(
                    client,
                    player,
                    new HomeSnapshot(dimension, target.goal(), target.interaction(), 0L, false)
                )) {
                finish(client, this, false, "recorded home reached but closed-door/light safety postcondition failed"
                    + progressSuffix());
                return;
            }
            finish(client, this, true, "recorded home reached, door closed, and safe light confirmed; position="
                + target.goal());
        }

        @Override
        String progressSuffix() {
            return "; kind=" + target.kind().name().toLowerCase(Locale.ROOT)
                + (target.kind() == TargetKind.HOME
                    ? "; home_phase=" + homePhase.name().toLowerCase(Locale.ROOT)
                    : "; waypoint=" + Math.min(waypointIndex + 1, target.waypoints().size())
                        + "/" + target.waypoints().size());
        }
    }

    private BuildSite findBuildSite(Minecraft client, LocalPlayer player, ApprovedZone zone, int radius) {
        BlockPos origin = player.blockPosition();
        List<BlockPos> candidates = new ArrayList<>();
        for (int dy = -2; dy <= 2; dy++) {
            for (int dx = -radius; dx <= radius; dx++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) > radius) continue;
                    candidates.add(origin.offset(dx, dy, dz));
                }
            }
        }
        candidates.sort(Comparator.comparingDouble(position -> player.distanceToSqr(Vec3.atCenterOf(position))));
        for (BlockPos center : candidates) {
            for (Direction doorDirection : doorDirectionsByApproach(center, player)) {
                BuildSite site = createBuildSite(center, doorDirection);
                if (validBuildSite(client, player, zone, site)) return site;
            }
        }
        return null;
    }

    private static BuildSite createBuildSite(BlockPos center, Direction doorDirection) {
        BlockPos door = center.relative(doorDirection);
        List<BlockPos> targets = new ArrayList<>();
        for (int dy = 0; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
                for (int dz = -1; dz <= 1; dz++) {
                    if (Math.abs(dx) != 1 && Math.abs(dz) != 1) continue;
                    BlockPos position = center.offset(dx, dy, dz);
                    if (position.equals(door.offset(0, dy, 0))) continue;
                    targets.add(position);
                }
            }
        }
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                if (dx == 0 && dz == 0) continue;
                targets.add(center.offset(dx, 2, dz));
            }
        }
        targets.add(center.above(2));
        return new BuildSite(center, door, doorDirection, targets);
    }

    private boolean validBuildSite(Minecraft client, LocalPlayer player, ApprovedZone zone, BuildSite site) {
        if (!allTargetsInside(site.targets(), zone)) return false;
        if (!zone.contains(site.home()) || !zone.contains(site.home().above(2))
            || !zone.contains(site.door()) || !zone.contains(site.door().above())) return false;
        if (client.level.hasNeighborSignal(site.door()) || client.level.hasNeighborSignal(site.door().above())) {
            return false;
        }
        if (nearestOtherPlayer(client, Vec3.atCenterOf(site.home()), minimumPlayerDistance) != null) return false;
        if (hasEnemyNear(client, player, site.home(), ENEMY_CLEAR_RADIUS)) return false;

        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                BlockPos floor = site.home().offset(dx, -1, dz);
                if (!client.level.isLoaded(floor) || !stableGround(client, player, floor)
                    || client.level.getBlockEntity(floor) != null) return false;
            }
        }
        for (BlockPos clear : List.of(site.home(), site.home().above(), site.door(), site.door().above())) {
            if (!replaceableWithoutBlockEntity(client, clear)) return false;
            if (!client.level.getEntitiesOfClass(
                Entity.class,
                new AABB(clear),
                entity -> entity != player && entity.isAlive() && !entity.isRemoved()
            ).isEmpty()) return false;
        }
        for (BlockPos target : site.targets()) {
            if (!replaceableWithoutBlockEntity(client, target)) return false;
            if (!client.level.getEntitiesOfClass(
                Entity.class,
                new AABB(target),
                entity -> entity != player && entity.isAlive() && !entity.isRemoved()
            ).isEmpty()) return false;
        }
        return isPhysicalStandPosition(client, player, site.home());
    }

    private MaterialChoice chooseMaterial(Minecraft client, LocalPlayer player, int required) {
        Map<Block, Integer> counts = new HashMap<>();
        Map<Block, BlockItem> items = new HashMap<>();
        Inventory inventory = player.getInventory();
        for (int slot = 0; slot < 36; slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (stack.isEmpty() || !(stack.getItem() instanceof BlockItem blockItem)) continue;
            Block block = blockItem.getBlock();
            if (!suitableOrdinaryBlock(client, player, block)) continue;
            counts.merge(block, stack.getCount(), Integer::sum);
            items.putIfAbsent(block, blockItem);
        }
        MaterialChoice best = null;
        for (Map.Entry<Block, Integer> entry : counts.entrySet()) {
            if (entry.getValue() < required) continue;
            Block block = entry.getKey();
            double resistance = Math.min(100.0D, Math.max(0.0D, block.getExplosionResistance()));
            double score = resistance * 10.0D + Math.min(entry.getValue(), 64);
            MaterialChoice candidate = new MaterialChoice(items.get(block), block, entry.getValue(), score);
            if (best == null || candidate.score() > best.score()) best = candidate;
        }
        return best;
    }

    private static FixtureChoice chooseUsableDoor(LocalPlayer player) {
        Inventory inventory = player.getInventory();
        for (int slot = 0; slot < 36; slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (stack.isEmpty() || !(stack.getItem() instanceof BlockItem blockItem)
                || !(blockItem.getBlock() instanceof DoorBlock doorBlock)
                || !doorBlock.type().canOpenByHand()) continue;
            return new FixtureChoice(blockItem, doorBlock);
        }
        return null;
    }

    private static FixtureChoice chooseSafeLight(LocalPlayer player) {
        Inventory inventory = player.getInventory();
        for (int slot = 0; slot < 36; slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (stack.isEmpty() || stack.getItem() != Items.TORCH
                || !(stack.getItem() instanceof BlockItem blockItem)
                || !(blockItem.getBlock() instanceof TorchBlock)) continue;
            return new FixtureChoice(blockItem, blockItem.getBlock());
        }
        return null;
    }

    private static boolean suitableOrdinaryBlock(Minecraft client, LocalPlayer player, Block block) {
        BlockState state = block.defaultBlockState();
        BlockPos probe = player.blockPosition();
        return !(block instanceof FallingBlock)
            && !state.hasBlockEntity()
            && state.getFluidState().isEmpty()
            && state.isCollisionShapeFullBlock(client.level, probe)
            && !state.is(BlockTags.LEAVES)
            && !dangerous(state);
    }

    private MaterialStatus prepareSelectedItem(
        Minecraft client,
        LocalPlayer player,
        BuildTask task,
        BlockItem requiredItem
    ) {
        Inventory inventory = player.getInventory();
        if (!inventory.getSelectedItem().isEmpty()
            && inventory.getSelectedItem().getItem() == requiredItem) {
            task.inventoryRequestTick = -1L;
            return MaterialStatus.READY;
        }
        if (task.inventoryRequestTick >= 0L) {
            return tick - task.inventoryRequestTick > INVENTORY_CONFIRM_TICKS
                ? MaterialStatus.MISSING
                : MaterialStatus.WAITING;
        }

        int hotbar = findItemSlot(inventory, requiredItem, 0, 9);
        if (hotbar >= 0) {
            inventory.setSelectedSlot(hotbar);
            player.connection.send(new ServerboundSetCarriedItemPacket(hotbar));
            task.inventoryRequestTick = tick;
            return MaterialStatus.WAITING;
        }
        int source = findItemSlot(inventory, requiredItem, 9, 36);
        if (source < 0) return MaterialStatus.MISSING;
        if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
            return MaterialStatus.INVALID_MENU;
        }
        int destination = emptyHotbarSlot(inventory);
        if (destination < 0) destination = inventory.getSelectedSlot();
        client.gameMode.handleContainerInput(
            player.inventoryMenu.containerId,
            source,
            destination,
            ContainerInput.SWAP,
            player
        );
        inventory.setSelectedSlot(destination);
        player.connection.send(new ServerboundSetCarriedItemPacket(destination));
        task.inventoryRequestTick = tick;
        return MaterialStatus.WAITING;
    }

    private PlacementSupport findPlacementSupport(
        Minecraft client,
        LocalPlayer player,
        BlockPos target,
        BlockItem item,
        Block expectedBlock
    ) {
        for (Direction face : List.of(
            Direction.UP,
            Direction.NORTH,
            Direction.SOUTH,
            Direction.WEST,
            Direction.EAST,
            Direction.DOWN
        )) {
            BlockPos support = target.relative(face.getOpposite());
            if (!client.level.isLoaded(support)) continue;
            BlockState supportState = client.level.getBlockState(support);
            if (supportState.canBeReplaced() || client.level.getBlockEntity(support) != null) continue;
            if (!supportState.isFaceSturdy(client.level, support, face)) continue;
            Vec3 hitLocation = Vec3.atCenterOf(support).add(
                face.getStepX() * 0.5D,
                face.getStepY() * 0.5D,
                face.getStepZ() * 0.5D
            );
            BlockHitResult hit = new BlockHitResult(hitLocation, face, support, false);
            BlockPlaceContext context = item.updatePlacementContext(new BlockPlaceContext(
                player,
                InteractionHand.MAIN_HAND,
                player.getInventory().getSelectedItem(),
                hit
            ));
            BlockState predicted = context == null ? null : expectedBlock.getStateForPlacement(context);
            if (context != null && context.getClickedPos().equals(target) && predicted != null) {
                return new PlacementSupport(support, face, hit);
            }
        }
        return null;
    }

    private ShelterTarget chooseShelterTarget(Minecraft client, LocalPlayer player, int radius) {
        HomeSnapshot remembered = home;
        if (remembered != null && remembered.dimension().equals(dimensionId(client))
            && player.distanceToSqr(Vec3.atCenterOf(remembered.position())) <= (double) radius * radius
            && client.level.isLoaded(remembered.position())
            && recordedHomeEnvironmentValid(client, player, remembered)) {
            List<BlockPos> waypoints = new ArrayList<>();
            if (!arrived(player, remembered.position())) {
                int dx = Integer.compare(remembered.door().getX(), remembered.position().getX());
                int dz = Integer.compare(remembered.door().getZ(), remembered.position().getZ());
                BlockPos outside = remembered.door().offset(dx, 0, dz);
                if (!isPhysicalStandPosition(client, player, outside)) return findFallbackShelter(client, player, radius);
                waypoints.add(outside);
            }
            waypoints.add(remembered.position());
            return new ShelterTarget(TargetKind.HOME, remembered.position(), remembered.door(), waypoints);
        }

        return findFallbackShelter(client, player, radius);
    }

    private ShelterTarget findFallbackShelter(Minecraft client, LocalPlayer player, int radius) {
        ShelterTarget bed = findNearbyBed(client, player, radius);
        if (bed != null) return bed;

        BlockPos safe = findNearbySafePosition(client, player, Math.min(radius, 14));
        if (safe == null) return null;
        return new ShelterTarget(TargetKind.SAFE_POSITION, safe, null, List.of(safe));
    }

    private static boolean recordedHomeEnvironmentValid(
        Minecraft client,
        LocalPlayer player,
        HomeSnapshot remembered
    ) {
        if (!usableHomeDoor(client, remembered.door())) return false;
        BlockState light = client.level.getBlockState(remembered.position());
        int blockLight = client.level.getBrightness(
            net.minecraft.world.level.LightLayer.BLOCK,
            remembered.position()
        );
        return light.is(Blocks.TORCH)
            && blockLight > client.level.dimensionType().monsterSpawnBlockLightLimit()
            && isSafePosition(client, player, remembered.position());
    }

    private ShelterTarget findNearbyBed(Minecraft client, LocalPlayer player, int radius) {
        if (!client.level.dimension().equals(Level.OVERWORLD)) return null;
        BlockPos origin = player.blockPosition();
        List<BlockPos> beds = new ArrayList<>();
        int vertical = Math.min(6, radius / 2);
        for (BlockPos mutable : BlockPos.betweenClosed(
            origin.offset(-radius, -vertical, -radius),
            origin.offset(radius, vertical, radius)
        )) {
            BlockPos position = mutable.immutable();
            if (!client.level.isLoaded(position)) continue;
            BlockState state = client.level.getBlockState(position);
            if (!state.is(BlockTags.BEDS) || !(state.getBlock() instanceof BedBlock)) continue;
            if (state.hasProperty(BedBlock.OCCUPIED) && state.getValue(BedBlock.OCCUPIED)) continue;
            beds.add(position);
        }
        beds.sort(Comparator.comparingDouble(position -> player.distanceToSqr(Vec3.atCenterOf(position))));
        for (BlockPos bed : beds) {
            for (Direction direction : HORIZONTAL_DIRECTIONS) {
                BlockPos stand = bed.relative(direction);
                if (!isPhysicalStandPosition(client, player, stand)) continue;
                if (hasEnemyNear(client, player, stand, ENEMY_CLEAR_RADIUS)) continue;
                if (dangerNear(client, stand)) continue;
                return new ShelterTarget(TargetKind.BED, stand, bed, List.of(stand));
            }
        }
        return null;
    }

    private BlockPos findNearbySafePosition(Minecraft client, LocalPlayer player, int radius) {
        BlockPos origin = player.blockPosition();
        List<BlockPos> candidates = new ArrayList<>();
        for (int dy = -3; dy <= 3; dy++) {
            for (int dx = -radius; dx <= radius; dx++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    if (dx * dx + dz * dz > radius * radius) continue;
                    candidates.add(origin.offset(dx, dy, dz));
                }
            }
        }
        candidates.sort(Comparator.comparingDouble(position -> safePositionScore(client, player, position)));
        for (BlockPos candidate : candidates) {
            if (isSafePosition(client, player, candidate)) return candidate;
        }
        return null;
    }

    private static double safePositionScore(Minecraft client, LocalPlayer player, BlockPos position) {
        double distance = player.distanceToSqr(Vec3.atCenterOf(position));
        if (client.level.isLoaded(position) && !client.level.canSeeSky(position.above())) distance -= 32.0D;
        return distance;
    }

    private static boolean isSafePosition(Minecraft client, LocalPlayer player, BlockPos feet) {
        if (!isPhysicalStandPosition(client, player, feet)) return false;
        if (dangerNear(client, feet)) return false;
        long clock = client.level.getOverworldClockTime();
        int timeOfDay = (int) Math.floorMod(clock, 24_000L);
        boolean night = client.level.dimensionType().hasSkyLight()
            && timeOfDay >= 12_542 && timeOfDay <= 23_460;
        boolean canSeeSky = client.level.canSeeSky(feet.above());
        int blockLight = client.level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, feet);
        int spawnLimit = client.level.dimensionType().monsterSpawnBlockLightLimit();
        if (night && canSeeSky) return false;
        if ((night || !canSeeSky) && blockLight <= spawnLimit) return false;
        return !hasEnemyNear(client, player, feet, ENEMY_CLEAR_RADIUS);
    }

    private static boolean isPhysicalStandPosition(Minecraft client, LocalPlayer player, BlockPos feet) {
        if (client == null || client.level == null || player == null) return false;
        BlockPos head = feet.above();
        BlockPos ground = feet.below();
        if (!client.level.isLoaded(feet) || !client.level.isLoaded(head) || !client.level.isLoaded(ground)) return false;
        if (!passable(client, feet) || !passable(client, head) || !stableGround(client, player, ground)) return false;
        Vec3 desired = new Vec3(feet.getX() + 0.5D, feet.getY(), feet.getZ() + 0.5D);
        AABB future = player.getBoundingBox().move(
            desired.x - player.getX(),
            desired.y - player.getY(),
            desired.z - player.getZ()
        );
        return client.level.noCollision(player, future);
    }

    private static boolean passable(Minecraft client, BlockPos position) {
        BlockState state = client.level.getBlockState(position);
        return state.getCollisionShape(client.level, position).isEmpty()
            && state.getFluidState().isEmpty()
            && !dangerous(state);
    }

    private static boolean stableGround(Minecraft client, LocalPlayer player, BlockPos position) {
        BlockState state = client.level.getBlockState(position);
        return state.getFluidState().isEmpty()
            && !dangerous(state)
            && state.entityCanStandOnFace(client.level, position, player, Direction.UP)
            && state.isCollisionShapeFullBlock(client.level, position);
    }

    private static boolean dangerNear(Minecraft client, BlockPos feet) {
        for (BlockPos mutable : BlockPos.betweenClosed(feet.offset(-1, -1, -1), feet.offset(1, 1, 1))) {
            BlockPos position = mutable.immutable();
            if (!client.level.isLoaded(position)) return true;
            BlockState state = client.level.getBlockState(position);
            if (dangerous(state)) return true;
        }
        return false;
    }

    private static boolean dangerous(BlockState state) {
        return state.is(BlockTags.FIRE)
            || state.is(BlockTags.CAMPFIRES)
            || state.is(Blocks.LAVA)
            || state.is(Blocks.CACTUS)
            || state.is(Blocks.MAGMA_BLOCK)
            || state.is(Blocks.SWEET_BERRY_BUSH)
            || state.is(Blocks.WITHER_ROSE)
            || state.is(Blocks.POWDER_SNOW)
            || state.is(Blocks.POINTED_DRIPSTONE)
            || state.is(Blocks.TNT);
    }

    private static boolean verifiedClosedDoor(Minecraft client, BlockPos lowerPos, Block expectedBlock) {
        BlockState lower = client.level.getBlockState(lowerPos);
        BlockState upper = client.level.getBlockState(lowerPos.above());
        if (!(expectedBlock instanceof DoorBlock doorBlock) || !doorBlock.type().canOpenByHand()) return false;
        return lower.is(expectedBlock)
            && upper.is(expectedBlock)
            && lower.hasProperty(DoorBlock.HALF)
            && upper.hasProperty(DoorBlock.HALF)
            && lower.getValue(DoorBlock.HALF) == DoubleBlockHalf.LOWER
            && upper.getValue(DoorBlock.HALF) == DoubleBlockHalf.UPPER
            && lower.hasProperty(DoorBlock.OPEN)
            && upper.hasProperty(DoorBlock.OPEN)
            && lower.hasProperty(DoorBlock.POWERED)
            && upper.hasProperty(DoorBlock.POWERED)
            && lower.hasProperty(DoorBlock.FACING)
            && upper.hasProperty(DoorBlock.FACING)
            && lower.hasProperty(DoorBlock.HINGE)
            && upper.hasProperty(DoorBlock.HINGE)
            && lower.getValue(DoorBlock.FACING) == upper.getValue(DoorBlock.FACING)
            && lower.getValue(DoorBlock.HINGE) == upper.getValue(DoorBlock.HINGE)
            && !lower.getValue(DoorBlock.OPEN)
            && !upper.getValue(DoorBlock.OPEN)
            && !lower.getValue(DoorBlock.POWERED)
            && !upper.getValue(DoorBlock.POWERED)
            && client.level.getBlockEntity(lowerPos) == null
            && client.level.getBlockEntity(lowerPos.above()) == null;
    }

    private static boolean usableHomeDoor(Minecraft client, BlockPos lowerPos) {
        if (!client.level.isLoaded(lowerPos) || !client.level.isLoaded(lowerPos.above())) return false;
        BlockState lower = client.level.getBlockState(lowerPos);
        BlockState upper = client.level.getBlockState(lowerPos.above());
        if (!(lower.getBlock() instanceof DoorBlock doorBlock) || !doorBlock.type().canOpenByHand()) return false;
        return upper.is(lower.getBlock())
            && lower.hasProperty(DoorBlock.HALF)
            && upper.hasProperty(DoorBlock.HALF)
            && lower.getValue(DoorBlock.HALF) == DoubleBlockHalf.LOWER
            && upper.getValue(DoorBlock.HALF) == DoubleBlockHalf.UPPER
            && lower.hasProperty(DoorBlock.FACING)
            && upper.hasProperty(DoorBlock.FACING)
            && lower.hasProperty(DoorBlock.HINGE)
            && upper.hasProperty(DoorBlock.HINGE)
            && lower.hasProperty(DoorBlock.OPEN)
            && upper.hasProperty(DoorBlock.OPEN)
            && lower.hasProperty(DoorBlock.POWERED)
            && upper.hasProperty(DoorBlock.POWERED)
            && lower.getValue(DoorBlock.FACING) == upper.getValue(DoorBlock.FACING)
            && lower.getValue(DoorBlock.HINGE) == upper.getValue(DoorBlock.HINGE)
            && lower.getValue(DoorBlock.OPEN) == upper.getValue(DoorBlock.OPEN)
            && lower.getValue(DoorBlock.POWERED) == upper.getValue(DoorBlock.POWERED)
            && !lower.getValue(DoorBlock.POWERED);
    }

    private static boolean homeDoorFullyOpen(Minecraft client, BlockPos lowerPos) {
        if (!usableHomeDoor(client, lowerPos)) return false;
        return client.level.getBlockState(lowerPos).getValue(DoorBlock.OPEN)
            && client.level.getBlockState(lowerPos.above()).getValue(DoorBlock.OPEN);
    }

    private static boolean homeDoorFullyClosed(Minecraft client, BlockPos lowerPos) {
        if (!usableHomeDoor(client, lowerPos)) return false;
        return !client.level.getBlockState(lowerPos).getValue(DoorBlock.OPEN)
            && !client.level.getBlockState(lowerPos.above()).getValue(DoorBlock.OPEN);
    }

    private static boolean doorwayOccupied(Minecraft client, LocalPlayer player, BlockPos lowerPos) {
        AABB doorway = new AABB(
            lowerPos.getX(),
            lowerPos.getY(),
            lowerPos.getZ(),
            lowerPos.getX() + 1.0D,
            lowerPos.getY() + 2.0D,
            lowerPos.getZ() + 1.0D
        );
        if (player.getBoundingBox().intersects(doorway)) return true;
        return !client.level.getEntitiesOfClass(
            Entity.class,
            doorway,
            entity -> entity != player && entity.isAlive() && !entity.isRemoved()
        ).isEmpty();
    }

    private static boolean hasEnemyNear(
        Minecraft client,
        LocalPlayer player,
        BlockPos position,
        double radius
    ) {
        return !client.level.getEntitiesOfClass(
            Mob.class,
            new AABB(position).inflate(radius),
            mob -> mob.isAlive() && !mob.isRemoved()
                && (mob instanceof Enemy || mob.getTarget() != null)
        ).isEmpty();
    }

    private static NearbyPlayer nearestOtherPlayer(Minecraft client, Vec3 position, double limit) {
        NearbyPlayer nearest = null;
        double nearestDistance = Double.POSITIVE_INFINITY;
        for (AbstractClientPlayer candidate : client.level.players()) {
            if (candidate == client.player || candidate.isRemoved()) continue;
            double distance = Math.sqrt(candidate.distanceToSqr(position));
            if (distance >= limit || distance >= nearestDistance) continue;
            nearestDistance = distance;
            nearest = new NearbyPlayer(candidate.getScoreboardName(), distance);
        }
        return nearest;
    }

    private MovementOutcome moveConservatively(Minecraft client, LocalPlayer player, BlockPos target) {
        if (arrived(player, target)) {
            navigator.release(client);
            return MovementOutcome.ARRIVED;
        }
        Vec3 goal = new Vec3(target.getX() + 0.5D, target.getY(), target.getZ() + 0.5D);
        return navigator.drive(client, player, goal, ARRIVAL_DISTANCE, false, tick)
            ? MovementOutcome.MOVING
            : MovementOutcome.BLOCKED;
    }

    private void checkMovementProgress(
        Minecraft client,
        LocalPlayer player,
        ShelterTask task,
        BlockPos target
    ) {
        Vec3 last;
        long lastTick;
        if (task instanceof BuildTask build) {
            last = build.lastProgressPosition;
            lastTick = build.lastProgressTick;
            if (last == null || player.position().distanceToSqr(last) >= 0.25D) {
                build.lastProgressPosition = player.position();
                build.lastProgressTick = tick;
                return;
            }
        } else if (task instanceof SeekTask seek) {
            last = seek.lastProgressPosition;
            lastTick = seek.lastProgressTick;
            if (last == null || player.position().distanceToSqr(last) >= 0.25D) {
                seek.lastProgressPosition = player.position();
                seek.lastProgressTick = tick;
                return;
            }
        } else {
            return;
        }
        if (tick - lastTick > MOVE_STUCK_TICKS) {
            finish(client, task, false, "movement stuck before waypoint " + target + task.progressSuffix());
        }
    }

    private String persistHome(HomeSnapshot snapshot) {
        if (!homePersistenceConfigured) return null;
        if (homeFile == null) return persistenceIssue == null ? "invalid MCAI_HOME_FILE path" : persistenceIssue;

        JsonObject json = new JsonObject();
        json.addProperty("version", HOME_FORMAT_VERSION);
        json.addProperty("dimension", snapshot.dimension());
        json.addProperty("x", snapshot.position().getX());
        json.addProperty("y", snapshot.position().getY());
        json.addProperty("z", snapshot.position().getZ());
        json.addProperty("doorX", snapshot.door().getX());
        json.addProperty("doorY", snapshot.door().getY());
        json.addProperty("doorZ", snapshot.door().getZ());
        json.addProperty("updatedAtEpochMs", snapshot.updatedAtEpochMs());

        Path temporary = null;
        try {
            Path absolute = homeFile.toAbsolutePath().normalize();
            Path parent = absolute.getParent();
            if (parent == null) return "home file has no parent directory";
            Files.createDirectories(parent);
            temporary = Files.createTempFile(parent, ".mcai-home-", ".tmp");
            Files.writeString(
                temporary,
                json.toString() + System.lineSeparator(),
                StandardCharsets.UTF_8,
                StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE
            );
            try {
                Files.move(
                    temporary,
                    absolute,
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                );
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary, absolute, StandardCopyOption.REPLACE_EXISTING);
            }
            persistenceIssue = null;
            return null;
        } catch (IOException | SecurityException error) {
            persistenceIssue = error.getClass().getSimpleName() + ": " + safeMessage(error);
            return persistenceIssue;
        } finally {
            if (temporary != null) {
                try {
                    Files.deleteIfExists(temporary);
                } catch (IOException ignored) {
                    // 最终结果已经上报了（如果有的话）实质性的持久化错误。
                }
            }
        }
    }

    private static HomeStorage loadHomeStorage() {
        String configured = System.getenv("MCAI_HOME_FILE");
        if (configured == null || configured.isBlank()) return new HomeStorage(null, false, null, null);
        Path file;
        try {
            file = Path.of(configured.trim()).toAbsolutePath().normalize();
        } catch (InvalidPathException error) {
            return new HomeStorage(null, true, null, "invalid path: " + safeMessage(error));
        }
        if (!Files.exists(file)) return new HomeStorage(file, true, null, null);
        try {
            if (!Files.isRegularFile(file)) return new HomeStorage(file, true, null, "path is not a regular file");
            if (Files.size(file) > MAX_HOME_FILE_BYTES) {
                return new HomeStorage(file, true, null, "home file exceeds 16 KiB limit");
            }
            JsonElement parsed = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) return new HomeStorage(file, true, null, "home JSON root is not an object");
            JsonObject json = parsed.getAsJsonObject();
            if (requiredInt(json, "version") != HOME_FORMAT_VERSION) {
                return new HomeStorage(file, true, null, "unsupported home JSON version");
            }
            String dimension = requiredString(json, "dimension");
            BlockPos position = new BlockPos(
                requiredInt(json, "x"),
                requiredInt(json, "y"),
                requiredInt(json, "z")
            );
            BlockPos door = new BlockPos(
                requiredInt(json, "doorX"),
                requiredInt(json, "doorY"),
                requiredInt(json, "doorZ")
            );
            long updated = requiredLong(json, "updatedAtEpochMs");
            String invalid = validateHomeCoordinates(dimension, position, door, updated);
            if (invalid != null) return new HomeStorage(file, true, null, invalid);
            return new HomeStorage(
                file,
                true,
                new HomeSnapshot(dimension, position, door, updated, true),
                null
            );
        } catch (Exception error) {
            return new HomeStorage(file, true, null,
                "invalid home JSON: " + error.getClass().getSimpleName() + ": " + safeMessage(error));
        }
    }

    private static String validateHomeCoordinates(
        String dimension,
        BlockPos position,
        BlockPos door,
        long updatedAtEpochMs
    ) {
        if (dimension.length() > 128 || !DIMENSION_PATTERN.matcher(dimension).matches()) {
            return "invalid home dimension identifier";
        }
        if (!Level.isInSpawnableBounds(position) || !Level.isInSpawnableBounds(door)) {
            return "home coordinates are outside Minecraft bounds";
        }
        int horizontalDistance = Math.abs(position.getX() - door.getX())
            + Math.abs(position.getZ() - door.getZ());
        if (position.getY() != door.getY() || horizontalDistance != 1) {
            return "door must be horizontally adjacent to home";
        }
        if (updatedAtEpochMs < 0L) return "invalid home timestamp";
        return null;
    }

    private void finish(Minecraft client, ShelterTask task, boolean ok, String detail) {
        if (active != task) return;
        navigator.release(client);
        clearMovement(client);
        if (taskInitialSelectedSlot >= 0 && client.player != null
            && client.player.getInventory().getSelectedSlot() != taskInitialSelectedSlot) {
            client.player.getInventory().setSelectedSlot(taskInitialSelectedSlot);
            client.player.connection.send(new ServerboundSetCarriedItemPacket(taskInitialSelectedSlot));
        }
        taskInitialSelectedSlot = -1;
        active = null;
        results.add(new TaskResult(task.id, ok, detail == null || detail.isBlank() ? "no_detail" : detail));
    }

    private static boolean replaceableWithoutBlockEntity(Minecraft client, BlockPos position) {
        return client.level.isLoaded(position)
            && client.level.getBlockState(position).canBeReplaced()
            && client.level.getBlockEntity(position) == null;
    }

    private static boolean allTargetsInside(List<BlockPos> targets, ApprovedZone zone) {
        for (BlockPos target : targets) if (!zone.contains(target)) return false;
        return true;
    }

    private static List<Direction> doorDirectionsByApproach(BlockPos center, LocalPlayer player) {
        List<Direction> directions = new ArrayList<>(HORIZONTAL_DIRECTIONS);
        directions.sort(Comparator.comparingDouble(direction ->
            player.distanceToSqr(Vec3.atCenterOf(center.relative(direction, 2)))
        ));
        return directions;
    }

    private static int findItemSlot(
        Inventory inventory,
        BlockItem item,
        int startInclusive,
        int endExclusive
    ) {
        for (int slot = startInclusive; slot < endExclusive; slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (!stack.isEmpty() && stack.getItem() == item) return slot;
        }
        return -1;
    }

    private static int emptyHotbarSlot(Inventory inventory) {
        for (int slot = 0; slot < 9; slot++) if (inventory.getItem(slot).isEmpty()) return slot;
        return -1;
    }

    private static boolean arrived(LocalPlayer player, BlockPos target) {
        double dx = target.getX() + 0.5D - player.getX();
        double dz = target.getZ() + 0.5D - player.getZ();
        return dx * dx + dz * dz <= ARRIVAL_DISTANCE * ARRIVAL_DISTANCE
            && Math.abs(player.getY() - target.getY()) <= 1.0D;
    }

    private static void lookAt(LocalPlayer player, Vec3 target) {
        double dx = target.x - player.getX();
        double dy = target.y - player.getEyeY();
        double dz = target.z - player.getZ();
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        player.setYRot((float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0D));
        player.setXRot((float) -Math.toDegrees(Math.atan2(dy, horizontal)));
    }

    private static void clearMovement(Minecraft client) {
        if (client == null || client.options == null) return;
        client.options.keyUp.setDown(false);
        client.options.keyDown.setDown(false);
        client.options.keyLeft.setDown(false);
        client.options.keyRight.setDown(false);
        client.options.keyJump.setDown(false);
        client.options.keySprint.setDown(false);
        client.options.keyShift.setDown(false);
    }

    private static String dimensionId(Minecraft client) {
        return client.level.dimension().identifier().toString();
    }

    private static String blockId(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    private static String blockId(Block block) {
        return BuiltInRegistries.BLOCK.getKey(block).toString();
    }

    private static String formatDistance(double distance) {
        return String.format(Locale.ROOT, "%.1f", distance);
    }

    private static boolean inWorld(Minecraft client) {
        return client != null && client.player != null && client.level != null && client.gameMode != null
            && client.player.isAlive() && !client.player.isSpectator();
    }

    private static int integer(JsonObject object, String key, int min, int max, int fallback) {
        if (!object.has(key)) return fallback;
        int value;
        try {
            value = object.get(key).getAsInt();
        } catch (Exception error) {
            throw new IllegalArgumentException(key + " must be an integer");
        }
        if (value < min || value > max) {
            throw new IllegalArgumentException(key + " must be between " + min + " and " + max);
        }
        return value;
    }

    private static String requiredString(JsonObject object, String key) {
        if (!object.has(key) || !object.get(key).isJsonPrimitive()) {
            throw new IllegalArgumentException("missing " + key);
        }
        String value = object.get(key).getAsString().trim();
        if (value.isBlank()) throw new IllegalArgumentException(key + " is blank");
        return value;
    }

    private static int requiredInt(JsonObject object, String key) {
        if (!object.has(key)) throw new IllegalArgumentException("missing " + key);
        return object.get(key).getAsInt();
    }

    private static long requiredLong(JsonObject object, String key) {
        if (!object.has(key)) throw new IllegalArgumentException("missing " + key);
        return object.get(key).getAsLong();
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) return "no_message";
        return message.replace('\r', ' ').replace('\n', ' ').trim();
    }
}
