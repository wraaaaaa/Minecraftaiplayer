package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.recipebook.RecipeCollection;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.StackedItemContents;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.CraftingMenu;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.item.component.Consumable;
import net.minecraft.world.item.component.ItemAttributeModifiers;
import net.minecraft.world.item.component.Tool;
import net.minecraft.world.item.consume_effects.ApplyStatusEffectsConsumeEffect;
import net.minecraft.world.item.consume_effects.ConsumeEffect;
import net.minecraft.world.item.crafting.display.RecipeDisplay;
import net.minecraft.world.item.crafting.display.RecipeDisplayEntry;
import net.minecraft.world.item.crafting.display.ShapedCraftingRecipeDisplay;
import net.minecraft.world.item.crafting.display.ShapelessCraftingRecipeDisplay;
import net.minecraft.world.item.crafting.display.SlotDisplayContext;
import net.minecraft.world.item.equipment.Equippable;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * A single-active-task, tick-driven executor for protocol-v2 primitive actions.
 *
 * <p>Every successful result is guarded by an observable client state transition that came back
 * through the normal multiplayer client. Calling a game-mode method is never itself considered
 * task completion.</p>
 */
public final class PrimitiveTaskController {
    private static final int CLICK_CONFIRM_TICKS = 40;
    private static final int USE_TIMEOUT_TICKS = 160;
    private static final int COLLECT_TIMEOUT_TICKS = 600;
    private static final int GATHER_TIMEOUT_TICKS = 1_200;
    private static final int CRAFT_TIMEOUT_TICKS = 400;
    private static final int PLACE_TIMEOUT_TICKS = 600;
    private static final int DROP_TIMEOUT_TICKS = 600;
    private static final int EQUIP_TIMEOUT_TICKS = 240;
    private static final long OWNED_DROP_TTL_MS = 5 * 60_000L;
    private static final List<EquipmentSlot> ARMOR_SLOTS = List.of(
        EquipmentSlot.HEAD,
        EquipmentSlot.CHEST,
        EquipmentSlot.LEGS,
        EquipmentSlot.FEET
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
            return position.getX() >= min.getX() && position.getX() <= max.getX()
                && position.getY() >= min.getY() && position.getY() <= max.getY()
                && position.getZ() >= min.getZ() && position.getZ() <= max.getZ();
        }
    }

    private record OwnedDrop(int entityId, String uuid, String itemId, long expiresAt) { }

    private final ArrayDeque<TaskResult> results = new ArrayDeque<>();
    private final Map<Integer, OwnedDrop> ownedDrops = new HashMap<>();
    private final LocalPathNavigator navigator = new LocalPathNavigator();
    private ApprovedZone approvedZone;
    private double minimumPlayerDistance = 48.0D;
    private PrimitiveTask active;
    private long tick;

    /** Accepts a supported action when no other primitive is active. */
    public boolean start(String id, JsonObject action, Minecraft client) {
        if (id == null || id.isBlank()) return false;
        if (active != null) {
            results.add(new TaskResult(id, false, "busy: active primitive is " + active.type));
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

        String type = action.get("type").getAsString();
        PrimitiveTask task;
        try {
            task = switch (type) {
                case "equip_best", "prepare_for" -> new EquipTask(id, type, action, tick);
                case "use_item" -> new UseItemTask(id, action, tick);
                case "collect_own_drops" -> createCollectTask(id, action, client);
                case "gather_resource" -> createGatherTask(id, action, client);
                case "craft_item" -> createCraftTask(id, action, client);
                case "place_block" -> createPlaceTask(id, action, client);
                case "drop_item" -> createDropTask(id, action, client);
                default -> null;
            };
        } catch (IllegalArgumentException error) {
            results.add(new TaskResult(id, false, "invalid_action: " + error.getMessage()));
            return false;
        }
        if (task == null) {
            if (!Set.of("collect_own_drops", "gather_resource", "craft_item", "place_block", "drop_item").contains(type)) {
                results.add(new TaskResult(id, false, "unsupported primitive: " + type));
            }
            return false;
        }
        active = task;
        return true;
    }

    /** Advances the active task by one client tick. */
    public void tick(Minecraft client) {
        tick++;
        pruneOwnedDrops(client);
        PrimitiveTask task = active;
        if (task == null) return;
        if (!inWorld(client)) {
            finish(client, task, false, "not_in_world");
            return;
        }
        if (tick - task.startedTick > task.timeoutTicks) {
            finish(client, task, false, "timeout: " + task.type);
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
        PrimitiveTask task = active;
        if (task == null) return false;
        finish(client, task, false, detail == null || detail.isBlank() ? "cancelled" : detail.trim());
        return true;
    }

    /** Returns and clears all terminal task results. */
    public List<TaskResult> drainResults() {
        List<TaskResult> drained = new ArrayList<>(results);
        results.clear();
        return drained;
    }

    /** Returns an empty string when no primitive is active. */
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

    public void setMinimumPlayerDistance(double distance) {
        minimumPlayerDistance = Math.max(0.0D, Math.min(512.0D, distance));
    }

    /** Explicitly marks an observed item entity as bot-owned provenance. */
    public void registerOwnedDrop(ItemEntity entity) {
        if (entity == null || entity.isRemoved() || entity.getItem().isEmpty()) return;
        ownedDrops.put(entity.getId(), new OwnedDrop(
            entity.getId(),
            entity.getUUID().toString(),
            itemId(entity.getItem()),
            System.currentTimeMillis() + OWNED_DROP_TTL_MS
        ));
    }

    /** Explicit registration overload for an integration that already has stable identifiers. */
    public void registerOwnedDrop(int entityId, String itemId) {
        if (entityId < 0 || itemId == null || itemId.isBlank()) return;
        ownedDrops.put(entityId, new OwnedDrop(
            entityId,
            "",
            normalizeId(itemId),
            System.currentTimeMillis() + OWNED_DROP_TTL_MS
        ));
    }

    public int registeredOwnedDropCount() {
        return ownedDrops.size();
    }

    private CollectDropsTask createCollectTask(String id, JsonObject action, Minecraft client) {
        String requestedItem = optionalId(action, "itemId");
        int count = integer(action, "count", 1, 64, 1);
        int radius = integer(action, "radius", 2, 16, 8);
        pruneOwnedDrops(client);
        List<OwnedDrop> visible = visibleOwnedDrops(client, requestedItem, radius);
        if (visible.isEmpty()) {
            String detail = ownedDrops.isEmpty()
                ? "refused: no registered bot-owned drop provenance"
                : "refused: registered bot-owned drops are not visible within radius or do not match itemId";
            results.add(new TaskResult(id, false, detail));
            return null;
        }
        return new CollectDropsTask(id, requestedItem, count, radius, tick);
    }

    private GatherResourceTask createGatherTask(String id, JsonObject action, Minecraft client) {
        boolean verifiedWilderness = booleanValue(action, "verifiedWilderness", false);
        LocalPlayer player = client.player;
        String authorizedPlayer = optionalString(action, "authorizedPlayer", null);
        ApprovedZone taskZone = approvedZone;
        boolean dynamicNaturalOnly = taskZone == null && verifiedWilderness;
        if (taskZone == null && verifiedWilderness) {
            // Natural extraction is authorized per target below. Nearby structures do not make
            // every natural ore/log illegal, and no manual coordinate box is required.
            taskZone = WildernessGuard.workZone(client, player.blockPosition(), 16, 24);
        }
        if (taskZone == null) {
            results.add(new TaskResult(id, false, "refused: dynamic environment verification was not authorized"));
            return null;
        }
        String dimension = client.level.dimension().identifier().toString();
        if (!taskZone.dimension().equals(dimension)) {
            results.add(new TaskResult(id, false, "refused: verified work window belongs to another dimension"));
            return null;
        }
        if (authorizedPlayer != null && !authorizedPlayer.matches("[A-Za-z0-9_]{1,16}")) {
            results.add(new TaskResult(id, false, "invalid authorizedPlayer name"));
            return null;
        }
        AbstractClientPlayer nearbyPlayer = nearestUnsafePlayer(client, player, null, authorizedPlayer);
        if (nearbyPlayer != null) {
            results.add(new TaskResult(id, false, "refused: player "
                + nearbyPlayer.getGameProfile().name() + " is only "
                + String.format(Locale.ROOT, "%.1f", nearbyPlayer.distanceTo(player))
                + " blocks away; wilderness minimum=" + minimumPlayerDistance));
            return null;
        }
        String resource = requiredString(action, "resource");
        int count = integer(action, "count", 1, 64, 1);
        ResourceMatcher matcher = ResourceMatcher.parse(resource);
        BlockPos requestedTarget = null;
        if (action.has("targetBlock") && action.get("targetBlock").isJsonObject()) {
            JsonObject target = action.getAsJsonObject("targetBlock");
            if (!target.has("x") || !target.has("y") || !target.has("z")) {
                results.add(new TaskResult(id, false, "invalid targetBlock coordinates"));
                return null;
            }
            requestedTarget = new BlockPos(target.get("x").getAsInt(), target.get("y").getAsInt(), target.get("z").getAsInt());
            if (count != 1 || !taskZone.contains(requestedTarget)) {
                results.add(new TaskResult(id, false, "targeted break must be one block inside the verified task window"));
                return null;
            }
            if (!client.level.isLoaded(requestedTarget)
                || client.level.getBlockEntity(requestedTarget) != null
                || !matcher.matches(client.level.getBlockState(requestedTarget))) {
                results.add(new TaskResult(id, false, "player-pointed block changed, is unloaded, or does not match " + matcher.description()));
                return null;
            }
        }
        return new GatherResourceTask(id, matcher, count, taskZone, authorizedPlayer, requestedTarget, dynamicNaturalOnly, tick);
    }

    private CraftItemTask createCraftTask(String id, JsonObject action, Minecraft client) {
        String targetItemId = normalizeId(requiredString(action, "itemId"));
        int count = integer(action, "count", 1, 64, 1);
        LocalPlayer player = client.player;
        if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
            results.add(new TaskResult(id, false, "craft_item requires the normal player 2x2 inventory with an empty cursor"));
            return null;
        }
        RecipeDisplayEntry recipe = findCraftableRecipe(client, player, targetItemId, 2);
        boolean requiresTable = false;
        if (recipe == null) {
            recipe = findCraftableRecipe(client, player, targetItemId, 3);
            requiresTable = recipe != null;
        }
        if (recipe == null) {
            results.add(new TaskResult(id, false, "no unlocked craftable 2x2/3x3 recipe with available ingredients for " + targetItemId));
            return null;
        }
        ApprovedZone taskZone = approvedZone;
        if (requiresTable && taskZone == null && booleanValue(action, "verifiedWilderness", false)) {
            taskZone = WildernessGuard.workZone(client, player.blockPosition(), 8, 8);
        }
        if (requiresTable && taskZone == null) {
            results.add(new TaskResult(id, false, "3x3 crafting requires dynamic environment authorization and a bot-owned crafting table"));
            return null;
        }
        return new CraftItemTask(id, targetItemId, count, recipe, requiresTable, taskZone, tick);
    }

    private PlaceBlockTask createPlaceTask(String id, JsonObject action, Minecraft client) {
        ApprovedZone taskZone = approvedZone;
        if (taskZone == null && booleanValue(action, "verifiedWilderness", false)) {
            taskZone = WildernessGuard.workZone(client, client.player.blockPosition(), 8, 8);
        }
        if (taskZone == null) {
            results.add(new TaskResult(id, false, "refused: dynamic placement verification was not authorized"));
            return null;
        }
        String dimension = client.level.dimension().identifier().toString();
        if (!taskZone.dimension().equals(dimension)) {
            results.add(new TaskResult(id, false, "refused: verified placement work window belongs to another dimension"));
            return null;
        }
        String requestedItemId = optionalId(action, "itemId");
        int count = integer(action, "count", 1, 16, 1);
        PlaceableCandidate material = findPlaceableCandidate(client, client.player, requestedItemId);
        if (material == null) {
            results.add(new TaskResult(id, false, requestedItemId == null
                ? "no ordinary safe full-block material in inventory"
                : "requested item is missing or is not an ordinary safe full block: " + requestedItemId));
            return null;
        }
        return new PlaceBlockTask(id, requestedItemId, count, taskZone, tick);
    }

    private DropItemTask createDropTask(String id, JsonObject action, Minecraft client) {
        String target = requiredString(action, "target");
        if (!target.matches("[A-Za-z0-9_]{1,16}")) {
            results.add(new TaskResult(id, false, "invalid target player name"));
            return null;
        }
        String requestedItemId = optionalId(action, "itemId");
        int count = integer(action, "count", 1, 64, 1);
        if (findInventoryItemSlot(client.player, requestedItemId) < 0) {
            results.add(new TaskResult(id, false, requestedItemId == null
                ? "inventory has no droppable item"
                : "requested item is not in inventory: " + requestedItemId));
            return null;
        }
        return new DropItemTask(id, target, requestedItemId, count, tick);
    }

    private abstract class PrimitiveTask {
        final String id;
        final String type;
        final long startedTick;
        final int timeoutTicks;
        final LocalPathNavigator navigator = new LocalPathNavigator();

        PrimitiveTask(String id, String type, long startedTick, int timeoutTicks) {
            this.id = id;
            this.type = type;
            this.startedTick = startedTick;
            this.timeoutTicks = timeoutTicks;
        }

        abstract void tick(Minecraft client);

        void cleanup(Minecraft client) {
            navigator.release(client);
            clearTaskControls(client);
        }
    }

    private final class EquipTask extends PrimitiveTask {
        private enum Phase { PLAN, WAIT_UNEQUIP, WAIT_EQUIP, WAIT_HELD_SWAP, VERIFY_HELD }

        private final String purpose;
        private final boolean preparation;
        private final List<String> notes = new ArrayList<>();
        private int armorIndex;
        private Phase phase = Phase.PLAN;
        private EquipmentSlot pendingSlot;
        private String pendingItemId;
        private long phaseStartedTick;
        private int expectedHeldSlot = -1;
        private int heldSourceSlot = -1;
        private StackFingerprint heldCandidate;
        private StackFingerprint heldDisplaced;
        private int heldSwapStateId = -1;
        private int equippedChanges;

        EquipTask(String id, String type, JsonObject action, long startedTick) {
            super(id, type, startedTick, EQUIP_TIMEOUT_TICKS);
            purpose = optionalString(action, "purpose", "general").toLowerCase(Locale.ROOT);
            if (!Set.of("general", "mining", "combat", "end_combat").contains(purpose)) {
                throw new IllegalArgumentException("invalid purpose: " + purpose);
            }
            preparation = "prepare_for".equals(type);
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
                finish(client, this, false, "equipment requires the normal inventory menu with an empty cursor");
                return;
            }

            if (phase == Phase.WAIT_UNEQUIP) {
                if (player.getItemBySlot(pendingSlot).isEmpty()) {
                    ItemCandidate candidate = bestArmorCandidate(player, pendingSlot);
                    if (candidate == null || !candidate.itemId().equals(pendingItemId)) {
                        finish(client, this, false, "armor candidate disappeared after unequip: " + pendingItemId);
                        return;
                    }
                    client.gameMode.handleContainerInput(0, inventoryMenuSlot(candidate.inventorySlot()), 0, ContainerInput.QUICK_MOVE, player);
                    phase = Phase.WAIT_EQUIP;
                    phaseStartedTick = tick;
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not confirm unequip for " + pendingSlot.getSerializedName());
                }
                return;
            }

            if (phase == Phase.WAIT_EQUIP) {
                ItemStack equipped = player.getItemBySlot(pendingSlot);
                if (!equipped.isEmpty() && itemId(equipped).equals(pendingItemId)) {
                    equippedChanges++;
                    armorIndex++;
                    phase = Phase.PLAN;
                    pendingSlot = null;
                    pendingItemId = null;
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not confirm equip for " + pendingItemId);
                }
                return;
            }

            if (phase == Phase.WAIT_HELD_SWAP) {
                if (tick - phaseStartedTick >= 2L
                    && player.inventoryMenu.getStateId() != heldSwapStateId
                    && heldCandidate.matches(player.getInventory().getItem(expectedHeldSlot))
                    && heldDisplaced.matches(player.getInventory().getItem(heldSourceSlot))) {
                    selectHotbar(player, expectedHeldSlot);
                    phase = Phase.VERIFY_HELD;
                    phaseStartedTick = tick;
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not confirm best held-item swap from inventory slot "
                        + heldSourceSlot + " to hotbar slot " + expectedHeldSlot);
                }
                return;
            }

            if (phase == Phase.VERIFY_HELD) {
                if (expectedHeldSlot >= 0 && player.getInventory().getSelectedSlot() != expectedHeldSlot) {
                    finish(client, this, false, "server did not retain selected best hotbar item");
                    return;
                }
                if (tick - phaseStartedTick < 2L) return;
                ItemCandidate bestHeld = bestHeldCandidate(player, purpose);
                ItemStack selected = player.getInventory().getSelectedItem();
                double selectedScore = heldItemScore(player, selected, purpose);
                if (bestHeld != null && bestHeld.score() > selectedScore + 0.0001D) {
                    finish(client, this, false, "selected held item is no longer the best safe candidate: "
                        + bestHeld.itemId() + "@" + bestHeld.inventorySlot());
                    return;
                }
                List<String> unresolvedBest = unresolvedArmorUpgrades(player);
                if (!unresolvedBest.isEmpty()) {
                    finish(client, this, false, "best armor not equipped: " + String.join(", ", unresolvedBest));
                    return;
                }
                List<String> gaps = "end_combat".equals(purpose) ? endCombatGaps(player) : List.of();
                String detail = "equipped_changes=" + equippedChanges
                    + "; selected=" + selectedItemDescription(player)
                    + (notes.isEmpty() ? "" : "; notes=" + String.join("|", notes))
                    + (gaps.isEmpty() ? "; readiness=ready" : "; end_combat_gaps=" + String.join("|", gaps));
                if (preparation && "end_combat".equals(purpose) && !gaps.isEmpty()) {
                    finish(client, this, false, detail);
                } else {
                    finish(client, this, true, detail);
                }
                return;
            }

            if (armorIndex < ARMOR_SLOTS.size()) {
                EquipmentSlot slot = ARMOR_SLOTS.get(armorIndex);
                ItemCandidate candidate = bestArmorCandidate(player, slot);
                ItemStack current = player.getItemBySlot(slot);
                if (candidate == null || armorScore(candidate.stack(), slot) <= armorScore(current, slot) + 0.0001D) {
                    armorIndex++;
                    return;
                }
                pendingSlot = slot;
                pendingItemId = candidate.itemId();
                phaseStartedTick = tick;
                if (!current.isEmpty()) {
                    if (player.getInventory().getFreeSlot() < 0) {
                        notes.add(slot.getSerializedName() + ":inventory_full_cannot_swap");
                        armorIndex++;
                        phase = Phase.PLAN;
                        return;
                    }
                    client.gameMode.handleContainerInput(0, armorMenuSlot(slot), 0, ContainerInput.QUICK_MOVE, player);
                    phase = Phase.WAIT_UNEQUIP;
                } else {
                    client.gameMode.handleContainerInput(0, inventoryMenuSlot(candidate.inventorySlot()), 0, ContainerInput.QUICK_MOVE, player);
                    phase = Phase.WAIT_EQUIP;
                }
                return;
            }

            ItemCandidate held = bestHeldCandidate(player, purpose);
            if (held == null) {
                notes.add("no_suitable_safe_" + ("mining".equals(purpose) ? "tool" : "weapon"));
                phase = Phase.VERIFY_HELD;
                phaseStartedTick = tick;
                return;
            }
            if (Inventory.isHotbarSlot(held.inventorySlot())) {
                expectedHeldSlot = held.inventorySlot();
                selectHotbar(player, expectedHeldSlot);
                phase = Phase.VERIFY_HELD;
                phaseStartedTick = tick;
                return;
            }

            expectedHeldSlot = chooseHeldSwapDestination(player, purpose);
            heldSourceSlot = held.inventorySlot();
            heldCandidate = StackFingerprint.of(held.stack());
            heldDisplaced = StackFingerprint.of(player.getInventory().getItem(expectedHeldSlot));
            heldSwapStateId = player.inventoryMenu.getStateId();
            client.gameMode.handleContainerInput(
                player.inventoryMenu.containerId,
                inventoryMenuSlot(heldSourceSlot),
                expectedHeldSlot,
                ContainerInput.SWAP,
                player
            );
            notes.add("best_held_swapped_from_inventory_" + heldSourceSlot + "_to_hotbar_" + expectedHeldSlot);
            phase = Phase.WAIT_HELD_SWAP;
            phaseStartedTick = tick;
        }
    }

    private final class UseItemTask extends PrimitiveTask {
        private enum Phase { LOCATE, WAIT_SWAP, USE, VERIFY }

        private final String requestedItemId;
        private Phase phase = Phase.LOCATE;
        private String actualItemId;
        private int selectedSlot = -1;
        private int swapSourceSlot = -1;
        private int swapStateId = -1;
        private StackFingerprint swapCandidate;
        private StackFingerprint swapDisplaced;
        private long phaseStartedTick;
        private long useStartedTick;
        private int beforeCount;
        private int beforeDamage;
        private int beforeFood;
        private float beforeHealth;
        private boolean consumable;

        UseItemTask(String id, JsonObject action, long startedTick) {
            super(id, "use_item", startedTick, USE_TIMEOUT_TICKS);
            requestedItemId = optionalId(action, "itemId");
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;

            if (phase == Phase.WAIT_SWAP) {
                if (player.containerMenu != player.inventoryMenu) {
                    finish(client, this, false, "requested-item swap cancelled: normal player inventory menu is no longer active");
                    return;
                }
                if (!player.inventoryMenu.getCarried().isEmpty()) {
                    finish(client, this, false, "requested-item swap cancelled: cursor became non-empty");
                    return;
                }
                boolean stateConfirmed = player.inventoryMenu.getStateId() != swapStateId;
                boolean destinationConfirmed = swapCandidate.matches(player.getInventory().getItem(selectedSlot));
                boolean sourceConfirmed = swapDisplaced.matches(player.getInventory().getItem(swapSourceSlot));
                if (tick - phaseStartedTick >= 2L && stateConfirmed && destinationConfirmed && sourceConfirmed) {
                    phase = Phase.USE;
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not confirm requested-item swap: item=" + requestedItemId
                        + "; source_inventory_slot=" + swapSourceSlot
                        + "; destination_hotbar_slot=" + selectedSlot
                        + "; menu_state_changed=" + stateConfirmed
                        + "; destination_matches=" + destinationConfirmed
                        + "; source_matches_displaced_stack=" + sourceConfirmed);
                }
                return;
            }

            if (phase == Phase.LOCATE) {
                selectedSlot = requestedItemId == null
                    ? player.getInventory().getSelectedSlot()
                    : findHotbarItem(player, requestedItemId);
                if (selectedSlot < 0 && requestedItemId != null) {
                    swapSourceSlot = findBackpackItem(player, requestedItemId);
                    if (swapSourceSlot < 0) {
                        finish(client, this, false, "requested item is unavailable in inventory: " + requestedItemId);
                        return;
                    }
                    if (player.containerMenu != player.inventoryMenu) {
                        finish(client, this, false, "cannot move requested item from inventory slot " + swapSourceSlot
                            + ": normal player inventory menu is not active");
                        return;
                    }
                    if (!player.inventoryMenu.getCarried().isEmpty()) {
                        finish(client, this, false, "cannot move requested item from inventory slot " + swapSourceSlot
                            + ": inventory cursor must be empty");
                        return;
                    }
                    selectedSlot = chooseUseSwapDestination(player);
                    swapCandidate = StackFingerprint.of(player.getInventory().getItem(swapSourceSlot));
                    swapDisplaced = StackFingerprint.of(player.getInventory().getItem(selectedSlot));
                    swapStateId = player.inventoryMenu.getStateId();
                    client.gameMode.handleContainerInput(
                        player.inventoryMenu.containerId,
                        inventoryMenuSlot(swapSourceSlot),
                        selectedSlot,
                        ContainerInput.SWAP,
                        player
                    );
                    phase = Phase.WAIT_SWAP;
                    phaseStartedTick = tick;
                    return;
                }
                phase = Phase.USE;
            }

            if (phase == Phase.USE) {
                selectHotbar(player, selectedSlot);
                ItemStack stack = player.getInventory().getSelectedItem();
                if (stack.isEmpty()) {
                    finish(client, this, false, "selected item is empty");
                    return;
                }
                actualItemId = itemId(stack);
                if (requestedItemId != null && !requestedItemId.equals(actualItemId)) {
                    finish(client, this, false, "selected item changed before use: expected="
                        + requestedItemId + "; actual=" + actualItemId);
                    return;
                }
                beforeCount = inventoryCount(player, actualItemId);
                beforeDamage = stack.getDamageValue();
                beforeFood = player.getFoodData().getFoodLevel();
                beforeHealth = player.getHealth();
                consumable = stack.has(DataComponents.CONSUMABLE);
                InteractionResult interaction = client.gameMode.useItem(player, InteractionHand.MAIN_HAND);
                if (!interaction.consumesAction() && !player.isUsingItem()) {
                    finish(client, this, false, "item use was rejected: " + actualItemId);
                    return;
                }
                phase = Phase.VERIFY;
                useStartedTick = tick;
                if (consumable || player.isUsingItem()) client.options.keyUse.setDown(true);
                return;
            }

            ItemStack selected = player.getInventory().getSelectedItem();
            boolean itemCountChanged = inventoryCount(player, actualItemId) < beforeCount;
            boolean durabilityChanged = !selected.isEmpty()
                && itemId(selected).equals(actualItemId)
                && selected.getDamageValue() > beforeDamage;
            boolean survivalChanged = player.getFoodData().getFoodLevel() > beforeFood || player.getHealth() > beforeHealth;
            boolean cooldownObserved = !selected.isEmpty() && player.getCooldowns().isOnCooldown(selected);
            if (itemCountChanged || durabilityChanged || survivalChanged || cooldownObserved) {
                client.options.keyUse.setDown(false);
                finish(client, this, true, "verified item use: " + actualItemId);
                return;
            }

            if (player.isUsingItem()) {
                if (consumable) client.options.keyUse.setDown(true);
                else {
                    client.gameMode.releaseUsingItem(player);
                    client.options.keyUse.setDown(false);
                    finish(client, this, false, "unsupported continuous non-consumable use without target/postcondition: " + actualItemId);
                }
                return;
            }

            client.options.keyUse.setDown(false);
            if (tick - useStartedTick > 20L) {
                finish(client, this, false, "item use produced no verifiable postcondition: " + actualItemId);
            }
        }
    }

    private final class CollectDropsTask extends PrimitiveTask {
        private final String requestedItemId;
        private final int requestedCount;
        private final int radius;
        private int baselineCount;
        private Integer targetEntityId;
        private Vec3 lastProgressPosition;
        private long lastProgressTick;

        CollectDropsTask(String id, String requestedItemId, int requestedCount, int radius, long startedTick) {
            super(id, "collect_own_drops", startedTick, COLLECT_TIMEOUT_TICKS);
            this.requestedItemId = requestedItemId;
            this.requestedCount = requestedCount;
            this.radius = radius;
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (baselineCount == 0 && tick == startedTick + 1L) {
                baselineCount = requestedItemId == null ? totalInventoryCount(player) : inventoryCount(player, requestedItemId);
                lastProgressPosition = player.position();
                lastProgressTick = tick;
            }
            int currentCount = requestedItemId == null ? totalInventoryCount(player) : inventoryCount(player, requestedItemId);
            if (currentCount - baselineCount >= requestedCount) {
                finish(client, this, true, "verified collected_count=" + (currentCount - baselineCount));
                return;
            }

            ItemEntity target = resolveOwnedTarget(client, player, requestedItemId, radius, targetEntityId);
            if (target == null) {
                targetEntityId = null;
                List<OwnedDrop> remaining = visibleOwnedDrops(client, requestedItemId, radius);
                if (remaining.isEmpty()) {
                    finish(client, this, false, "owned drops exhausted; verified_count=" + (currentCount - baselineCount)
                        + "; requested=" + requestedCount);
                    return;
                }
                targetEntityId = remaining.getFirst().entityId();
                target = resolveOwnedTarget(client, player, requestedItemId, radius, targetEntityId);
                if (target == null) return;
            }

            double distance = player.distanceTo(target);
            if (distance <= 1.25D) {
                clearMovement(client);
            } else {
                if (!navigator.drive(client, player, target.position(), 1.0D, false, tick)
                    && navigator.consecutivePlanFailures() >= 3) {
                    finish(client, this, false, "no collision-safe route to registered owned drop entityId=" + target.getId());
                    return;
                }
            }

            if (lastProgressPosition == null || player.position().distanceToSqr(lastProgressPosition) >= 0.25D) {
                lastProgressPosition = player.position();
                lastProgressTick = tick;
            } else if (distance > 1.25D && tick - lastProgressTick > 50L) {
                finish(client, this, false, "unable to reach registered owned drop entityId=" + target.getId());
            }
        }
    }

    private final class GatherResourceTask extends PrimitiveTask {
        private enum Phase { SEEK, MOVE, WAIT_TOOL_SWAP, BREAK, OBSERVE_DROPS }

        private final ResourceMatcher matcher;
        private final int requestedCount;
        private final ApprovedZone taskZone;
        private final String authorizedPlayer;
        private final BlockPos requestedTarget;
        private final boolean dynamicNaturalOnly;
        private final Set<BlockPos> completedPositions = new HashSet<>();
        private final Set<Integer> dropIdsBefore = new HashSet<>();
        private Phase phase = Phase.SEEK;
        private BlockPos target;
        private String expectedBlockId;
        private Direction face;
        private int completedCount;
        private int registeredDropCount;
        private long phaseStartedTick;
        private Vec3 lastProgressPosition;
        private long lastProgressTick;
        private int toolSourceSlot = -1;
        private int toolHotbarSlot = -1;
        private StackFingerprint toolCandidate;
        private StackFingerprint toolDisplaced;
        private int toolSwapStateId = -1;
        private final int baselineInventoryCount;

        GatherResourceTask(
            String id,
            ResourceMatcher matcher,
            int requestedCount,
            ApprovedZone taskZone,
            String authorizedPlayer,
            BlockPos requestedTarget,
            boolean dynamicNaturalOnly,
            long startedTick
        ) {
            super(id, "gather_resource", startedTick, GATHER_TIMEOUT_TICKS);
            this.matcher = matcher;
            this.requestedCount = requestedCount;
            this.taskZone = taskZone;
            this.authorizedPlayer = authorizedPlayer;
            this.requestedTarget = requestedTarget == null ? null : requestedTarget.immutable();
            this.dynamicNaturalOnly = dynamicNaturalOnly;
            LocalPlayer player = Minecraft.getInstance().player;
            baselineInventoryCount = player == null ? 0 : totalInventoryCount(player);
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (!taskZone.dimension().equals(client.level.dimension().identifier().toString())) {
                finish(client, this, false, "left verified resource work dimension");
                return;
            }
            AbstractClientPlayer nearbyPlayer = nearestUnsafePlayer(client, player, target, authorizedPlayer);
            if (nearbyPlayer != null) {
                finish(client, this, false, nearbyPlayerCancellationDetail(nearbyPlayer, player, target));
                return;
            }

            if (phase == Phase.OBSERVE_DROPS) {
                for (ItemEntity drop : itemEntitiesNear(client, target, 3.0D)) {
                    if (dropIdsBefore.contains(drop.getId()) || ownedDrops.containsKey(drop.getId())) continue;
                    registerOwnedDrop(drop);
                    registeredDropCount++;
                }
                if (tick - phaseStartedTick < 10L) return;
                if (completedCount >= requestedCount) {
                    int inventoryDelta = Math.max(0, totalInventoryCount(player) - baselineInventoryCount);
                    if (registeredDropCount == 0 && inventoryDelta == 0) {
                        finish(client, this, false, "verified blocks broke but neither inventory growth nor owned drops were observed; resource="
                            + matcher.description());
                        return;
                    }
                    finish(client, this, true, "verified_broken_blocks=" + completedCount
                        + "; registered_owned_drops=" + registeredDropCount
                        + "; inventory_delta=" + inventoryDelta
                        + "; resource=" + matcher.description());
                } else {
                    phase = Phase.SEEK;
                    target = null;
                }
                return;
            }

            if (phase == Phase.SEEK) {
                target = requestedTarget != null && completedPositions.isEmpty()
                    ? requestedTarget
                    : findResourceTarget(client, player, matcher, completedPositions, taskZone);
                if (target == null) {
                    finish(client, this, false, "no matching safe loaded block in verified work window; verified_broken_blocks="
                        + completedCount + "; resource=" + matcher.description());
                    return;
                }
                if (dynamicNaturalOnly && !WildernessGuard.safeNaturalBreak(client, target)) {
                    completedPositions.add(target.immutable());
                    target = null;
                    return;
                }
                BlockState state = client.level.getBlockState(target);
                expectedBlockId = blockId(state);
                phase = Phase.MOVE;
                phaseStartedTick = tick;
                lastProgressPosition = player.position();
                lastProgressTick = tick;
            }

            nearbyPlayer = nearestUnsafePlayer(client, player, target, authorizedPlayer);
            if (nearbyPlayer != null) {
                finish(client, this, false, nearbyPlayerCancellationDetail(nearbyPlayer, player, target));
                return;
            }

            if (!taskZone.contains(target)) {
                finish(client, this, false, "target escaped verified resource work window");
                return;
            }
            BlockState current = client.level.getBlockState(target);
            // BREAK owns the server-change postcondition below. Handling it here would mistake a
            // successful break for an externally changed target, seek another block, and keep
            // mining until the whole dynamically verified work window is exhausted.
            if (phase != Phase.BREAK && (!blockId(current).equals(expectedBlockId) || !matcher.matches(current))) {
                completedPositions.add(target.immutable());
                phase = Phase.SEEK;
                return;
            }

            if (phase == Phase.WAIT_TOOL_SWAP) {
                if (tick - phaseStartedTick >= 2L
                    && player.inventoryMenu.getStateId() != toolSwapStateId
                    && toolCandidate.matches(player.getInventory().getItem(toolHotbarSlot))
                    && toolDisplaced.matches(player.getInventory().getItem(toolSourceSlot))) {
                    selectHotbar(player, toolHotbarSlot);
                    phase = Phase.MOVE;
                    phaseStartedTick = tick;
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not confirm tool swap from inventory slot "
                        + toolSourceSlot + " to hotbar slot " + toolHotbarSlot);
                }
                return;
            }

            if (phase == Phase.MOVE) {
                if (player.isWithinBlockInteractionRange(target, 0.0D)) {
                    clearMovement(client);
                    BlockHitResult sight = client.level.clip(new ClipContext(
                        player.getEyePosition(),
                        Vec3.atCenterOf(target),
                        ClipContext.Block.OUTLINE,
                        ClipContext.Fluid.NONE,
                        player
                    ));
                    if (sight.getType() != HitResult.Type.BLOCK || !sight.getBlockPos().equals(target)) {
                        completedPositions.add(target.immutable());
                        phase = Phase.SEEK;
                        return;
                    }
                    ItemCandidate tool = bestToolCandidate(player, current);
                    if (current.requiresCorrectToolForDrops()
                        && (tool == null || !tool.stack().isCorrectToolForDrops(current))) {
                        finish(client, this, false, "missing correct usable safe-durability tool for " + expectedBlockId);
                        return;
                    }
                    if (tool != null && !Inventory.isHotbarSlot(tool.inventorySlot())) {
                        if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
                            finish(client, this, false, "tool swap requires the normal inventory menu with an empty cursor");
                            return;
                        }
                        toolSourceSlot = tool.inventorySlot();
                        toolHotbarSlot = chooseToolSwapDestination(player, current);
                        toolCandidate = StackFingerprint.of(tool.stack());
                        toolDisplaced = StackFingerprint.of(player.getInventory().getItem(toolHotbarSlot));
                        toolSwapStateId = player.inventoryMenu.getStateId();
                        client.gameMode.handleContainerInput(
                            player.inventoryMenu.containerId,
                            inventoryMenuSlot(toolSourceSlot),
                            toolHotbarSlot,
                            ContainerInput.SWAP,
                            player
                        );
                        phase = Phase.WAIT_TOOL_SWAP;
                        phaseStartedTick = tick;
                        return;
                    }
                    if (tool != null) selectHotbar(player, tool.inventorySlot());
                    Vec3 center = Vec3.atCenterOf(target);
                    face = Direction.getApproximateNearest(
                        player.getX() - center.x,
                        player.getEyeY() - center.y,
                        player.getZ() - center.z
                    );
                    dropIdsBefore.clear();
                    for (ItemEntity existing : itemEntitiesNear(client, target, 3.0D)) dropIdsBefore.add(existing.getId());
                    lookAt(player, center.x, center.y, center.z);
                    if (!client.gameMode.startDestroyBlock(target, face)) {
                        finish(client, this, false, "server/client rejected startDestroyBlock for " + expectedBlockId);
                        return;
                    }
                    player.swing(InteractionHand.MAIN_HAND);
                    phase = Phase.BREAK;
                    phaseStartedTick = tick;
                    return;
                }
                // Move close enough that ordinary block drops are normally picked up
                // during the server-confirmed break, including a one-block depression.
                if (!navigator.drive(client, player, Vec3.atCenterOf(target), 1.85D, false, tick)
                    && navigator.consecutivePlanFailures() >= 3) {
                    finish(client, this, false, "no collision-safe route to verified resource block " + target.toShortString());
                    return;
                }
                if (player.position().distanceToSqr(lastProgressPosition) >= 0.25D) {
                    lastProgressPosition = player.position();
                    lastProgressTick = tick;
                } else if (tick - lastProgressTick > 60L) {
                    finish(client, this, false, "unable to reach verified resource block " + target.toShortString());
                }
                return;
            }

            if (phase == Phase.BREAK) {
                BlockState observed = client.level.getBlockState(target);
                if (!blockId(observed).equals(expectedBlockId)) {
                    client.gameMode.stopDestroyBlock();
                    completedPositions.add(target.immutable());
                    completedCount++;
                    phase = Phase.OBSERVE_DROPS;
                    phaseStartedTick = tick;
                    return;
                }
                if (!client.gameMode.continueDestroyBlock(target, face)) {
                    finish(client, this, false, "continueDestroyBlock failed before postcondition for " + expectedBlockId);
                    return;
                }
                player.swing(InteractionHand.MAIN_HAND);
            }
        }

        @Override
        void cleanup(Minecraft client) {
            if (client != null && client.gameMode != null && phase == Phase.BREAK) client.gameMode.stopDestroyBlock();
            super.cleanup(client);
        }
    }

    private final class DropItemTask extends PrimitiveTask {
        private final String targetName;
        private final String requestedItemId;
        private final int requestedCount;
        private final int baselineCount;
        private int previousCount;
        private long lastClickTick;
        private Vec3 lastProgressPosition;
        private long lastProgressTick;

        DropItemTask(String id, String targetName, String requestedItemId, int requestedCount, long startedTick) {
            super(id, "drop_item", startedTick, DROP_TIMEOUT_TICKS);
            this.targetName = targetName;
            this.requestedItemId = requestedItemId;
            this.requestedCount = requestedCount;
            LocalPlayer player = Minecraft.getInstance().player;
            this.baselineCount = player == null ? 0 : requestedItemId == null
                ? totalInventoryCount(player)
                : inventoryCount(player, requestedItemId);
            this.previousCount = baselineCount;
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            AbstractClientPlayer target = client.level.players().stream()
                .filter(candidate -> candidate != player && candidate.isAlive()
                    && candidate.getGameProfile().name().equalsIgnoreCase(targetName))
                .findFirst().orElse(null);
            if (target == null) {
                finish(client, this, false, "target player is no longer nearby: " + targetName);
                return;
            }
            double distance = player.distanceTo(target);
            if (distance > 3.2D) {
                if (!navigator.drive(client, player, target.position(), 2.5D, false, tick)
                    && navigator.consecutivePlanFailures() >= 3) {
                    finish(client, this, false, "no collision-safe route to receiving player " + target.getGameProfile().name());
                    return;
                }
                if (lastProgressPosition == null || player.position().distanceToSqr(lastProgressPosition) >= 0.16D) {
                    lastProgressPosition = player.position();
                    lastProgressTick = tick;
                } else if (tick - lastProgressTick > 80L) {
                    finish(client, this, false, "unable to navigate around obstacles to recipient " + targetName);
                }
                return;
            }
            clearMovement(client);
            if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
                finish(client, this, false, "drop_item requires normal inventory menu with empty cursor");
                return;
            }
            int currentCount = requestedItemId == null ? totalInventoryCount(player) : inventoryCount(player, requestedItemId);
            int dropped = baselineCount - currentCount;
            if (dropped >= requestedCount) {
                finish(client, this, true, "verified_dropped_count=" + dropped + "; recipient=" + targetName
                    + "; itemId=" + (requestedItemId == null ? "automatic" : requestedItemId));
                return;
            }
            if (currentCount < previousCount) {
                previousCount = currentCount;
                lastClickTick = tick;
                return;
            }
            if (tick - lastClickTick < 3L) return;
            int slot = findInventoryItemSlot(player, requestedItemId);
            if (slot < 0) {
                finish(client, this, false, "item exhausted after verified_dropped_count=" + dropped + "; requested=" + requestedCount);
                return;
            }
            lookAt(player, target.getX(), target.getEyeY(), target.getZ());
            client.gameMode.handleContainerInput(
                player.inventoryMenu.containerId,
                inventoryMenuSlot(slot),
                0,
                ContainerInput.THROW,
                player
            );
            lastClickTick = tick;
        }
    }

    private final class PlaceBlockTask extends PrimitiveTask {
        private enum Phase { PREPARE, WAIT_SWAP, PLACE, CROUCH_READY, VERIFY }

        private final String requestedItemId;
        private final int requestedCount;
        private final ApprovedZone taskZone;
        private final Set<BlockPos> completedPositions = new HashSet<>();
        private Phase phase = Phase.PREPARE;
        private long phaseStartedTick;
        private PlaceableCandidate material;
        private PlacementPlan placement;
        private int sourceSlot = -1;
        private int hotbarSlot = -1;
        private int swapStateId = -1;
        private StackFingerprint candidateFingerprint;
        private StackFingerprint displacedFingerprint;
        private int completedCount;
        private int stableTicks;
        private String lastInteraction = "none";

        PlaceBlockTask(String id, String requestedItemId, int requestedCount, ApprovedZone taskZone, long startedTick) {
            super(id, "place_block", startedTick, PLACE_TIMEOUT_TICKS);
            this.requestedItemId = requestedItemId;
            this.requestedCount = requestedCount;
            this.taskZone = taskZone;
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (!taskZone.dimension().equals(client.level.dimension().identifier().toString())) {
                finish(client, this, false, "left verified placement work dimension");
                return;
            }
            if (completedCount >= requestedCount) {
                finish(client, this, true, "verified_placed_blocks=" + completedCount
                    + "; requested_item=" + (requestedItemId == null ? "automatic_safe_block" : requestedItemId));
                return;
            }

            if (phase == Phase.WAIT_SWAP) {
                if (tick - phaseStartedTick >= 2L
                    && player.inventoryMenu.getStateId() != swapStateId
                    && candidateFingerprint.matches(player.getInventory().getItem(hotbarSlot))
                    && displacedFingerprint.matches(player.getInventory().getItem(sourceSlot))) {
                    selectHotbar(player, hotbarSlot);
                    phase = Phase.PLACE;
                    phaseStartedTick = tick;
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not confirm placement material swap");
                }
                return;
            }

            if (phase == Phase.VERIFY) {
                BlockState observed = client.level.getBlockState(placement.target());
                boolean safeUtility = requestedItemId != null && safeRequestedUtility(requestedItemId);
                if (observed.is(material.item().getBlock()) && !observed.canBeReplaced()
                    && (client.level.getBlockEntity(placement.target()) == null || safeUtility)) {
                    stableTicks++;
                    if (stableTicks >= 2) {
                        OwnedBlockRegistry.registerPlacedStructure(client, placement.target(), blockId(observed));
                        completedPositions.add(placement.target().immutable());
                        completedCount++;
                        stableTicks = 0;
                        placement = null;
                        material = null;
                        phase = Phase.PREPARE;
                        client.options.keyShift.setDown(false);
                    }
                    return;
                }
                stableTicks = 0;
                if (!observed.canBeReplaced() || client.level.getBlockEntity(placement.target()) != null) {
                    finish(client, this, false, "server reported unexpected block after placement; target="
                        + placement.target().toShortString() + "; observed=" + blockId(observed));
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not confirm place_block postcondition; target="
                        + placement.target().toShortString() + "; interaction=" + lastInteraction);
                }
                return;
            }

            if (phase == Phase.PREPARE) {
                material = findPlaceableCandidate(client, player, requestedItemId);
                if (material == null) {
                    finish(client, this, false, "safe placement material exhausted; verified_placed_blocks=" + completedCount);
                    return;
                }
                if (!Inventory.isHotbarSlot(material.inventorySlot())) {
                    if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
                        finish(client, this, false, "placement material swap requires normal inventory with empty cursor");
                        return;
                    }
                    sourceSlot = material.inventorySlot();
                    hotbarSlot = chooseUseSwapDestination(player);
                    candidateFingerprint = StackFingerprint.of(material.stack());
                    displacedFingerprint = StackFingerprint.of(player.getInventory().getItem(hotbarSlot));
                    swapStateId = player.inventoryMenu.getStateId();
                    client.gameMode.handleContainerInput(
                        player.inventoryMenu.containerId,
                        inventoryMenuSlot(sourceSlot),
                        hotbarSlot,
                        ContainerInput.SWAP,
                        player
                    );
                    phase = Phase.WAIT_SWAP;
                    phaseStartedTick = tick;
                    return;
                }
                selectHotbar(player, material.inventorySlot());
                phase = Phase.PLACE;
            }

            if (phase == Phase.PLACE) {
                ItemStack selected = player.getInventory().getSelectedItem();
                if (selected.isEmpty() || !(selected.getItem() instanceof BlockItem selectedItem)
                    || selectedItem != material.item()) {
                    phase = Phase.PREPARE;
                    return;
                }
                placement = findSimplePlacement(client, player, selectedItem, taskZone, completedPositions);
                if (placement == null) {
                    finish(client, this, false, "no safe reachable replaceable target in verified placement work window; verified_placed_blocks="
                        + completedCount);
                    return;
                }
                lookAt(player, placement.hit().getLocation().x, placement.hit().getLocation().y, placement.hit().getLocation().z);
                client.options.keyShift.setDown(true);
                phase = Phase.CROUCH_READY;
                phaseStartedTick = tick;
                return;
            }

            if (phase == Phase.CROUCH_READY) {
                if (tick <= phaseStartedTick) return;
                ItemStack selected = player.getInventory().getSelectedItem();
                if (selected.isEmpty() || selected.getItem() != material.item()) {
                    client.options.keyShift.setDown(false);
                    phase = Phase.PREPARE;
                    return;
                }
                if (!taskZone.contains(placement.target())
                    || !client.level.getBlockState(placement.target()).canBeReplaced()
                    || client.level.getBlockEntity(placement.target()) != null) {
                    finish(client, this, false, "placement target changed before interaction");
                    return;
                }
                InteractionResult interaction = client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, placement.hit());
                lastInteraction = interaction.getClass().getSimpleName();
                if (!interaction.consumesAction()) {
                    finish(client, this, false, "placement interaction rejected: " + lastInteraction);
                    return;
                }
                player.swing(InteractionHand.MAIN_HAND);
                phase = Phase.VERIFY;
                phaseStartedTick = tick;
                stableTicks = 0;
            }
        }

        @Override
        void cleanup(Minecraft client) {
            if (client != null) client.options.keyShift.setDown(false);
            super.cleanup(client);
        }
    }

    private final class CraftItemTask extends PrimitiveTask {
        private enum Phase { SEEK_TABLE, MOVE_TABLE, OPEN_TABLE, WAIT_MENU, PLACE_RECIPE, WAIT_RESULT, WAIT_INVENTORY }

        private final String targetItemId;
        private final int requestedCount;
        private final boolean requiresTable;
        private final ApprovedZone taskZone;
        private RecipeDisplayEntry recipe;
        private final int baselineCount;
        private int previousCount;
        private Phase phase;
        private long phaseStartedTick;
        private BlockPos craftingTable;
        private Vec3 lastProgressPosition;
        private long lastProgressTick;

        CraftItemTask(
            String id,
            String targetItemId,
            int requestedCount,
            RecipeDisplayEntry recipe,
            boolean requiresTable,
            ApprovedZone taskZone,
            long startedTick
        ) {
            super(id, "craft_item", startedTick, CRAFT_TIMEOUT_TICKS);
            this.targetItemId = targetItemId;
            this.requestedCount = requestedCount;
            this.recipe = recipe;
            this.requiresTable = requiresTable;
            this.taskZone = taskZone;
            phase = requiresTable ? Phase.SEEK_TABLE : Phase.PLACE_RECIPE;
            LocalPlayer player = Minecraft.getInstance().player;
            baselineCount = player == null ? 0 : inventoryCount(player, targetItemId);
            previousCount = baselineCount;
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            int currentCount = inventoryCount(player, targetItemId);
            if (currentCount - baselineCount >= requestedCount) {
                finish(client, this, true, "verified_crafted_count=" + (currentCount - baselineCount)
                    + "; itemId=" + targetItemId + "; grid=" + (requiresTable ? "3x3" : "2x2"));
                return;
            }

            if (requiresTable && phase == Phase.SEEK_TABLE) {
                if (!taskZone.dimension().equals(client.level.dimension().identifier().toString())) {
                    finish(client, this, false, "left verified crafting-table work dimension");
                    return;
                }
                craftingTable = findCraftingTable(client, player, taskZone);
                if (craftingTable == null) {
                    finish(client, this, false, "no bot-owned loaded crafting table in the verified work window within 8 blocks");
                    return;
                }
                phase = Phase.MOVE_TABLE;
                phaseStartedTick = tick;
                lastProgressPosition = player.position();
                lastProgressTick = tick;
            }

            if (requiresTable && phase == Phase.MOVE_TABLE) {
                if (!taskZone.contains(craftingTable) || !client.level.getBlockState(craftingTable).is(Blocks.CRAFTING_TABLE)) {
                    finish(client, this, false, "bot-owned crafting table changed or left the verified work window");
                    return;
                }
                if (player.isWithinBlockInteractionRange(craftingTable, 0.0D)) {
                    clearMovement(client);
                    phase = Phase.OPEN_TABLE;
                } else {
                    if (!navigator.drive(client, player, Vec3.atCenterOf(craftingTable), 2.5D, false, tick)
                        && navigator.consecutivePlanFailures() >= 3) {
                        finish(client, this, false, "no collision-safe route to crafting table " + craftingTable.toShortString());
                        return;
                    }
                    if (player.position().distanceToSqr(lastProgressPosition) >= 0.25D) {
                        lastProgressPosition = player.position();
                        lastProgressTick = tick;
                    } else if (tick - lastProgressTick > 60L) {
                        finish(client, this, false, "unable to reach verified bot-owned crafting table " + craftingTable.toShortString());
                    }
                    return;
                }
            }

            if (requiresTable && phase == Phase.OPEN_TABLE) {
                if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) {
                    finish(client, this, false, "cannot open crafting table while another menu/cursor is active");
                    return;
                }
                Vec3 hitLocation = Vec3.atCenterOf(craftingTable).add(0.0D, 0.5D, 0.0D);
                BlockHitResult hit = new BlockHitResult(hitLocation, Direction.UP, craftingTable, false);
                lookAt(player, hitLocation.x, hitLocation.y, hitLocation.z);
                InteractionResult interaction = client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
                if (!interaction.consumesAction()) {
                    finish(client, this, false, "server rejected crafting table interaction: " + interaction.getClass().getSimpleName());
                    return;
                }
                player.swing(InteractionHand.MAIN_HAND);
                phase = Phase.WAIT_MENU;
                phaseStartedTick = tick;
                return;
            }

            if (requiresTable && phase == Phase.WAIT_MENU) {
                if (player.containerMenu instanceof CraftingMenu) {
                    phase = Phase.PLACE_RECIPE;
                    phaseStartedTick = tick;
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not open 3x3 crafting menu");
                }
                return;
            }

            boolean validMenu = requiresTable
                ? player.containerMenu instanceof CraftingMenu && player.containerMenu.getCarried().isEmpty()
                : player.containerMenu == player.inventoryMenu && player.inventoryMenu.getCarried().isEmpty();
            if (!validMenu) {
                finish(client, this, false, (requiresTable ? "3x3 table" : "2x2 inventory") + " crafting context changed");
                return;
            }

            if (phase == Phase.PLACE_RECIPE) {
                RecipeDisplayEntry currentRecipe = findCraftableRecipe(client, player, targetItemId, requiresTable ? 3 : 2);
                if (currentRecipe == null) {
                    finish(client, this, false, "ingredients exhausted or unlocked recipe unavailable; verified_crafted_count="
                        + (currentCount - baselineCount));
                    return;
                }
                recipe = currentRecipe;
                previousCount = currentCount;
                client.gameMode.handlePlaceRecipe(player.containerMenu.containerId, recipe.id(), false);
                phase = Phase.WAIT_RESULT;
                phaseStartedTick = tick;
                return;
            }

            if (phase == Phase.WAIT_RESULT) {
                ItemStack result = requiresTable
                    ? ((CraftingMenu) player.containerMenu).getResultSlot().getItem()
                    : player.inventoryMenu.getResultSlot().getItem();
                if (!result.isEmpty() && itemId(result).equals(targetItemId)) {
                    client.gameMode.handleContainerInput(
                        player.containerMenu.containerId,
                        requiresTable ? CraftingMenu.RESULT_SLOT : InventoryMenu.RESULT_SLOT,
                        0,
                        ContainerInput.QUICK_MOVE,
                        player
                    );
                    phase = Phase.WAIT_INVENTORY;
                    phaseStartedTick = tick;
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not populate crafting result slot for " + targetItemId);
                }
                return;
            }

            if (phase == Phase.WAIT_INVENTORY) {
                if (currentCount > previousCount) {
                    phase = Phase.PLACE_RECIPE;
                    phaseStartedTick = tick;
                    return;
                }
                if (tick - phaseStartedTick > CLICK_CONFIRM_TICKS) {
                    finish(client, this, false, "server did not confirm crafted result transfer for " + targetItemId);
                }
            }
        }

        @Override
        void cleanup(Minecraft client) {
            if (requiresTable && client != null && client.player != null
                && client.player.containerMenu instanceof CraftingMenu) {
                client.player.closeContainer();
            }
            super.cleanup(client);
        }
    }

    private void finish(Minecraft client, PrimitiveTask task, boolean ok, String detail) {
        if (active != task) return;
        task.cleanup(client);
        navigator.release(client);
        active = null;
        results.add(new TaskResult(task.id, ok, detail == null ? "" : detail));
    }

    private static boolean inWorld(Minecraft client) {
        return client != null && client.player != null && client.level != null && client.gameMode != null;
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? "no detail" : message.replace('\n', ' ').replace('\r', ' ');
    }

    private static String requiredString(JsonObject action, String key) {
        if (!action.has(key) || !action.get(key).isJsonPrimitive()) throw new IllegalArgumentException("missing " + key);
        String value = action.get(key).getAsString().trim();
        if (value.isEmpty()) throw new IllegalArgumentException("empty " + key);
        return value;
    }

    private static String optionalString(JsonObject action, String key, String fallback) {
        if (!action.has(key) || !action.get(key).isJsonPrimitive()) return fallback;
        String value = action.get(key).getAsString().trim();
        return value.isEmpty() ? fallback : value;
    }

    private static String optionalId(JsonObject action, String key) {
        if (!action.has(key) || !action.get(key).isJsonPrimitive()) return null;
        String value = action.get(key).getAsString().trim();
        return value.isEmpty() ? null : normalizeId(value);
    }

    private static int integer(JsonObject action, String key, int minimum, int maximum, int fallback) {
        if (!action.has(key) || !action.get(key).isJsonPrimitive()) return fallback;
        try {
            return Math.max(minimum, Math.min(maximum, action.get(key).getAsInt()));
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    private static boolean booleanValue(JsonObject action, String key, boolean fallback) {
        if (!action.has(key) || !action.get(key).isJsonPrimitive()) return fallback;
        try {
            return action.get(key).getAsBoolean();
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    private static String normalizeId(String value) {
        Identifier identifier = Identifier.tryParse(value.trim().toLowerCase(Locale.ROOT));
        if (identifier == null) throw new IllegalArgumentException("invalid identifier: " + value);
        return identifier.toString();
    }

    private static String itemId(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    private static String blockId(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    private static int inventoryCount(LocalPlayer player, String targetItemId) {
        int total = 0;
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (!stack.isEmpty() && itemId(stack).equals(targetItemId)) total += stack.getCount();
        }
        return total;
    }

    private static int totalInventoryCount(LocalPlayer player) {
        int total = 0;
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (!stack.isEmpty()) total += stack.getCount();
        }
        return total;
    }

    private static int findHotbarItem(LocalPlayer player, String targetItemId) {
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (!stack.isEmpty() && itemId(stack).equals(targetItemId)) return slot;
        }
        return -1;
    }

    private static int findBackpackItem(LocalPlayer player, String targetItemId) {
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        for (int slot = Inventory.getSelectionSize(); slot < items.size() && slot < Inventory.INVENTORY_SIZE; slot++) {
            ItemStack stack = items.get(slot);
            if (!stack.isEmpty() && itemId(stack).equals(targetItemId)) return slot;
        }
        return -1;
    }

    private static int chooseUseSwapDestination(LocalPlayer player) {
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            if (player.getInventory().getItem(slot).isEmpty()) return slot;
        }

        int selected = player.getInventory().getSelectedSlot();
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            if (slot == selected) continue;
            ItemStack stack = player.getInventory().getItem(slot);
            if (!stack.has(DataComponents.WEAPON)
                && !stack.has(DataComponents.TOOL)
                && !stack.has(DataComponents.FOOD)) {
                return slot;
            }
        }
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            if (slot != selected) return slot;
        }
        return selected;
    }

    private static void selectHotbar(LocalPlayer player, int slot) {
        if (!Inventory.isHotbarSlot(slot)) throw new IllegalArgumentException("not a hotbar slot: " + slot);
        if (player.getInventory().getSelectedSlot() == slot) return;
        player.getInventory().setSelectedSlot(slot);
        player.connection.send(new ServerboundSetCarriedItemPacket(slot));
    }

    private static int inventoryMenuSlot(int inventorySlot) {
        if (inventorySlot < 0 || inventorySlot >= Inventory.INVENTORY_SIZE) {
            throw new IllegalArgumentException("invalid inventory slot: " + inventorySlot);
        }
        return Inventory.isHotbarSlot(inventorySlot)
            ? InventoryMenu.USE_ROW_SLOT_START + inventorySlot
            : inventorySlot;
    }

    private static int findInventoryItemSlot(LocalPlayer player, String requestedItemId) {
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        for (int slot = 0; slot < items.size() && slot < Inventory.INVENTORY_SIZE; slot++) {
            ItemStack stack = items.get(slot);
            if (stack.isEmpty()) continue;
            if (requestedItemId == null || requestedItemId.equals(itemId(stack))) return slot;
        }
        return -1;
    }

    private static int armorMenuSlot(EquipmentSlot slot) {
        return switch (slot) {
            case HEAD -> InventoryMenu.ARMOR_SLOT_START;
            case CHEST -> InventoryMenu.ARMOR_SLOT_START + 1;
            case LEGS -> InventoryMenu.ARMOR_SLOT_START + 2;
            case FEET -> InventoryMenu.ARMOR_SLOT_START + 3;
            default -> throw new IllegalArgumentException("not an armor slot: " + slot);
        };
    }

    private static PlaceableCandidate findPlaceableCandidate(
        Minecraft client,
        LocalPlayer player,
        String requestedItemId
    ) {
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        PlaceableCandidate best = null;
        for (int slot = 0; slot < items.size() && slot < Inventory.INVENTORY_SIZE; slot++) {
            ItemStack stack = items.get(slot);
            if (stack.isEmpty() || !(stack.getItem() instanceof BlockItem blockItem)) continue;
            String id = itemId(stack);
            if (requestedItemId != null && !requestedItemId.equals(id)) continue;
            if (!ordinaryPlacementMaterial(client, player, blockItem)
                && !(requestedItemId != null && safeRequestedUtility(id))) continue;
            PlaceableCandidate candidate = new PlaceableCandidate(slot, id, blockItem, stack);
            if (best == null
                || (Inventory.isHotbarSlot(slot) && !Inventory.isHotbarSlot(best.inventorySlot()))
                || (Inventory.isHotbarSlot(slot) == Inventory.isHotbarSlot(best.inventorySlot())
                    && stack.getCount() > best.stack().getCount())) {
                best = candidate;
            }
        }
        return best;
    }

    private static boolean ordinaryPlacementMaterial(Minecraft client, LocalPlayer player, BlockItem item) {
        Block block = item.getBlock();
        BlockState state = block.defaultBlockState();
        if (state.hasBlockEntity() || !state.isCollisionShapeFullBlock(client.level, player.blockPosition())) return false;
        String path = BuiltInRegistries.BLOCK.getKey(block).getPath();
        return Set.of(
            "dirt", "coarse_dirt", "rooted_dirt", "grass_block", "stone", "cobblestone",
            "granite", "diorite", "andesite", "deepslate", "cobbled_deepslate", "tuff",
            "calcite", "netherrack", "end_stone", "bricks", "mud_bricks", "crafting_table"
        ).contains(path)
            || path.endsWith("_bricks")
            || path.endsWith("_log")
            || path.endsWith("_wood")
            || path.endsWith("_planks")
            || path.endsWith("_wool")
            || path.endsWith("_log")
            || path.endsWith("_wood");
    }

    private static boolean safeRequestedUtility(String itemId) {
        String path = itemId.substring(itemId.indexOf(':') + 1);
        return Set.of(
            "furnace", "smoker", "blast_furnace", "enchanting_table",
            "anvil", "chipped_anvil", "damaged_anvil", "brewing_stand"
        ).contains(path) || path.endsWith("_bed");
    }

    private static PlacementPlan findSimplePlacement(
        Minecraft client,
        LocalPlayer player,
        BlockItem item,
        ApprovedZone zone,
        Set<BlockPos> excluded
    ) {
        BlockPos center = player.blockPosition();
        List<BlockPos> candidates = new ArrayList<>();
        for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -3; dx <= 3; dx++) {
                for (int dz = -3; dz <= 3; dz++) {
                    if (Math.abs(dx) + Math.abs(dz) < 1) continue;
                    candidates.add(center.offset(dx, dy, dz));
                }
            }
        }
        candidates.sort(Comparator
            .comparingInt((BlockPos position) -> Math.abs(position.getY() - center.getY()))
            .thenComparingDouble(position -> player.distanceToSqr(Vec3.atCenterOf(position))));
        ItemStack selected = player.getInventory().getSelectedItem();
        for (BlockPos target : candidates) {
            if (excluded.contains(target) || !zone.contains(target) || !client.level.isLoaded(target)) continue;
            if (!WildernessGuard.safePlacementArea(client, target, 5)) continue;
            BlockState before = client.level.getBlockState(target);
            if (!before.canBeReplaced() || client.level.getBlockEntity(target) != null) continue;
            for (Direction face : List.of(Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST, Direction.DOWN)) {
                BlockPos support = target.relative(face.getOpposite());
                if (!client.level.isLoaded(support) || !player.isWithinBlockInteractionRange(support, 0.0D)) continue;
                BlockState supportState = client.level.getBlockState(support);
                if (supportState.canBeReplaced() || client.level.getBlockEntity(support) != null
                    || !supportState.isFaceSturdy(client.level, support, face)) continue;
                Vec3 hitLocation = Vec3.atCenterOf(support).add(
                    face.getStepX() * 0.5D,
                    face.getStepY() * 0.5D,
                    face.getStepZ() * 0.5D
                );
                BlockHitResult hit = new BlockHitResult(hitLocation, face, support, false);
                BlockPlaceContext context = item.updatePlacementContext(new BlockPlaceContext(
                    player,
                    InteractionHand.MAIN_HAND,
                    selected,
                    hit
                ));
                if (context == null || !context.canPlace() || !context.getClickedPos().equals(target)) continue;
                BlockState predicted = item.getBlock().getStateForPlacement(context);
                if (predicted == null || !predicted.canSurvive(client.level, target)
                    || !client.level.isUnobstructed(predicted, target, CollisionContext.placementContext(player))) continue;
                if (!player.mayUseItemAt(support, face, selected)) continue;
                return new PlacementPlan(target.immutable(), support.immutable(), face, hit);
            }
        }
        return null;
    }

    private static ItemCandidate bestArmorCandidate(LocalPlayer player, EquipmentSlot slot) {
        ItemCandidate best = null;
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        for (int inventorySlot = 0; inventorySlot < items.size(); inventorySlot++) {
            ItemStack stack = items.get(inventorySlot);
            if (stack.isEmpty()) continue;
            Equippable equippable = stack.get(DataComponents.EQUIPPABLE);
            if (equippable == null || equippable.slot() != slot || !equippable.canBeEquippedBy(player.typeHolder())) continue;
            double score = armorScore(stack, slot);
            if (best == null || score > best.score()) {
                best = new ItemCandidate(inventorySlot, itemId(stack), stack, score);
            }
        }
        return best;
    }

    private static double armorScore(ItemStack stack, EquipmentSlot slot) {
        if (stack == null || stack.isEmpty()) return 0.0D;
        int remaining = stack.isDamageableItem() ? stack.getMaxDamage() - stack.getDamageValue() : Integer.MAX_VALUE;
        if (remaining <= 3) return -1.0D;
        ItemAttributeModifiers modifiers = stack.get(DataComponents.ATTRIBUTE_MODIFIERS);
        double armor = modifiers == null ? 0.0D : modifiers.compute(net.minecraft.world.entity.ai.attributes.Attributes.ARMOR, 0.0D, slot);
        double toughness = modifiers == null ? 0.0D : modifiers.compute(net.minecraft.world.entity.ai.attributes.Attributes.ARMOR_TOUGHNESS, 0.0D, slot);
        int enchantments = stack.getEnchantments().entrySet().stream().mapToInt(entry -> entry.getIntValue()).sum();
        double durability = stack.isDamageableItem() && stack.getMaxDamage() > 0
            ? (double) remaining / stack.getMaxDamage()
            : 1.0D;
        return armor * 10.0D + toughness * 3.0D + enchantments * 0.5D + durability;
    }

    private static ItemCandidate bestHeldCandidate(LocalPlayer player, String purpose) {
        ItemCandidate best = null;
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        for (int slot = 0; slot < items.size() && slot < Inventory.INVENTORY_SIZE; slot++) {
            ItemStack stack = items.get(slot);
            double score = heldItemScore(player, stack, purpose);
            if (!Double.isFinite(score)) continue;
            if (best == null
                || score > best.score() + 0.0001D
                || (Math.abs(score - best.score()) <= 0.0001D
                    && Inventory.isHotbarSlot(slot)
                    && !Inventory.isHotbarSlot(best.inventorySlot()))) {
                best = new ItemCandidate(slot, itemId(stack), stack, score);
            }
        }
        return best;
    }

    private static double heldItemScore(LocalPlayer player, ItemStack stack, String purpose) {
        return "mining".equals(purpose) ? genericToolScore(stack) : weaponScore(player, stack);
    }

    private static int chooseHeldSwapDestination(LocalPlayer player, String purpose) {
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            if (player.getInventory().getItem(slot).isEmpty()) return slot;
        }
        int destination = 0;
        double lowestScore = Double.POSITIVE_INFINITY;
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            double score = heldItemScore(player, player.getInventory().getItem(slot), purpose);
            if (score < lowestScore) {
                lowestScore = score;
                destination = slot;
            }
        }
        return destination;
    }

    private static ItemCandidate bestToolCandidate(LocalPlayer player, BlockState state) {
        ItemCandidate best = null;
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        for (int slot = 0; slot < items.size() && slot < Inventory.INVENTORY_SIZE; slot++) {
            ItemStack stack = items.get(slot);
            double score = blockToolScore(stack, state);
            if (!Double.isFinite(score)) continue;
            if (best == null
                || score > best.score() + 0.0001D
                || (Math.abs(score - best.score()) <= 0.0001D
                    && Inventory.isHotbarSlot(slot)
                    && !Inventory.isHotbarSlot(best.inventorySlot()))) {
                best = new ItemCandidate(slot, itemId(stack), stack, score);
            }
        }
        return best;
    }

    private static int chooseToolSwapDestination(LocalPlayer player, BlockState state) {
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            if (player.getInventory().getItem(slot).isEmpty()) return slot;
        }
        int destination = 0;
        double lowestScore = Double.POSITIVE_INFINITY;
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            double score = blockToolScore(player.getInventory().getItem(slot), state);
            if (score < lowestScore) {
                lowestScore = score;
                destination = slot;
            }
        }
        return destination;
    }

    private static double blockToolScore(ItemStack stack, BlockState state) {
        if (stack == null || stack.isEmpty() || stack.get(DataComponents.TOOL) == null || !hasSafeDurability(stack)) {
            return Double.NEGATIVE_INFINITY;
        }
        double score = stack.getDestroySpeed(state);
        if (stack.isCorrectToolForDrops(state)) score += 10_000.0D;
        int enchantments = stack.getEnchantments().entrySet().stream().mapToInt(entry -> entry.getIntValue()).sum();
        return score + enchantments * 0.01D;
    }

    private static double genericToolScore(ItemStack stack) {
        if (stack == null || stack.isEmpty() || !hasSafeDurability(stack)) return Double.NEGATIVE_INFINITY;
        Tool tool = stack.get(DataComponents.TOOL);
        if (tool == null) return Double.NEGATIVE_INFINITY;
        int enchantments = stack.getEnchantments().entrySet().stream().mapToInt(entry -> entry.getIntValue()).sum();
        return tool.defaultMiningSpeed() * 10.0D + enchantments * 0.5D;
    }

    private static double weaponScore(LocalPlayer player, ItemStack stack) {
        if (stack == null || stack.isEmpty() || !stack.has(DataComponents.WEAPON) || !hasSafeDurability(stack)) {
            return Double.NEGATIVE_INFINITY;
        }
        ItemAttributeModifiers modifiers = stack.get(DataComponents.ATTRIBUTE_MODIFIERS);
        double baseDamage = player.getAttributeBaseValue(net.minecraft.world.entity.ai.attributes.Attributes.ATTACK_DAMAGE);
        double baseSpeed = player.getAttributeBaseValue(net.minecraft.world.entity.ai.attributes.Attributes.ATTACK_SPEED);
        double damage = modifiers == null ? baseDamage : modifiers.compute(
            net.minecraft.world.entity.ai.attributes.Attributes.ATTACK_DAMAGE,
            baseDamage,
            EquipmentSlot.MAINHAND
        );
        double speed = modifiers == null ? baseSpeed : modifiers.compute(
            net.minecraft.world.entity.ai.attributes.Attributes.ATTACK_SPEED,
            baseSpeed,
            EquipmentSlot.MAINHAND
        );
        int enchantments = stack.getEnchantments().entrySet().stream().mapToInt(entry -> entry.getIntValue()).sum();
        return damage * Math.max(0.25D, Math.min(8.0D, speed))
            + enchantments * 0.35D
            + (stack.has(DataComponents.WEAPON) ? 2.0D : 0.0D);
    }

    private static List<String> unresolvedArmorUpgrades(LocalPlayer player) {
        List<String> unresolved = new ArrayList<>();
        for (EquipmentSlot slot : ARMOR_SLOTS) {
            ItemCandidate best = bestArmorCandidate(player, slot);
            if (best != null && best.score() > armorScore(player.getItemBySlot(slot), slot) + 0.0001D) {
                unresolved.add(slot.getSerializedName() + "->" + best.itemId());
            }
        }
        return unresolved;
    }

    private static List<String> endCombatGaps(LocalPlayer player) {
        List<String> gaps = new ArrayList<>();
        for (EquipmentSlot slot : ARMOR_SLOTS) {
            ItemStack stack = player.getItemBySlot(slot);
            if (stack.isEmpty()) {
                gaps.add(slot.getSerializedName() + "_armor_missing");
                continue;
            }
            int score = materialTier(itemId(stack)) * 2 + (stack.getEnchantments().isEmpty() ? 0 : 1);
            if (score < 5) gaps.add(slot.getSerializedName() + "_armor_below_enchanted_gold_equivalent");
            if (!hasSafeDurability(stack)) gaps.add(slot.getSerializedName() + "_armor_low_durability");
        }
        ItemStack held = player.getInventory().getSelectedItem();
        int weaponEquivalent = held.isEmpty() ? 0 : materialTier(itemId(held)) * 2 + (held.getEnchantments().isEmpty() ? 0 : 1);
        if (held.isEmpty() || !held.has(DataComponents.WEAPON) || weaponEquivalent < 5) {
            gaps.add("weapon_below_enchanted_gold_equivalent");
        }
        if (!held.isEmpty() && !hasSafeDurability(held)) gaps.add("weapon_low_durability");
        int food = 0;
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (isSafeConsumableFood(player, stack)) food += stack.getCount();
        }
        if (food < 16) gaps.add("safe_food_below_16(current=" + food + ")");
        return gaps;
    }

    private static int materialTier(String itemId) {
        if (itemId.contains("netherite_")) return 5;
        if (itemId.contains("diamond_")) return 4;
        if (itemId.contains("iron_")) return 3;
        if (itemId.contains("golden_") || itemId.contains("chainmail_") || itemId.contains("copper_")) return 2;
        if (itemId.contains("stone_") || itemId.contains("leather_") || itemId.contains("wooden_")) return 1;
        return 0;
    }

    private static boolean hasSafeDurability(ItemStack stack) {
        if (!stack.isDamageableItem() || stack.getMaxDamage() <= 0) return true;
        int remaining = stack.getMaxDamage() - stack.getDamageValue();
        return remaining >= Math.max(5, (int) Math.ceil(stack.getMaxDamage() * 0.2D));
    }

    private static boolean isSafeConsumableFood(LocalPlayer player, ItemStack stack) {
        if (stack == null || stack.isEmpty() || !stack.has(DataComponents.FOOD)) return false;
        Consumable consumable = stack.get(DataComponents.CONSUMABLE);
        if (consumable == null) return false;
        // A full player cannot eat ordinary food right now, but it is still valid future combat supply.
        if (!consumable.canConsume(player, stack) && player.getFoodData().needsFood()) return false;
        for (ConsumeEffect effect : consumable.onConsumeEffects()) {
            if (!(effect instanceof ApplyStatusEffectsConsumeEffect statusEffects)) return false;
            if (statusEffects.effects().stream().anyMatch(instance -> !instance.getEffect().value().isBeneficial())) {
                return false;
            }
        }
        return true;
    }

    private static String selectedItemDescription(LocalPlayer player) {
        ItemStack selected = player.getInventory().getSelectedItem();
        return selected.isEmpty() ? "none" : itemId(selected) + "@" + player.getInventory().getSelectedSlot();
    }

    private record PlaceableCandidate(int inventorySlot, String itemId, BlockItem item, ItemStack stack) { }

    private record PlacementPlan(BlockPos target, BlockPos support, Direction face, BlockHitResult hit) { }

    private record ItemCandidate(int inventorySlot, String itemId, ItemStack stack, double score) { }

    private record StackFingerprint(boolean empty, ItemStack expected) {
        static StackFingerprint of(ItemStack stack) {
            if (stack == null || stack.isEmpty()) return new StackFingerprint(true, ItemStack.EMPTY);
            return new StackFingerprint(false, stack.copy());
        }

        boolean matches(ItemStack stack) {
            if (empty) return stack == null || stack.isEmpty();
            return stack != null && !stack.isEmpty() && ItemStack.matches(expected, stack);
        }
    }

    private void pruneOwnedDrops(Minecraft client) {
        long now = System.currentTimeMillis();
        ownedDrops.entrySet().removeIf(entry -> {
            OwnedDrop provenance = entry.getValue();
            if (provenance.expiresAt() < now) return true;
            if (client == null || client.level == null) return false;
            Entity entity = client.level.getEntity(provenance.entityId());
            if (entity == null) return false;
            if (!(entity instanceof ItemEntity item) || item.isRemoved()) return true;
            return !provenance.uuid().isEmpty() && !item.getUUID().toString().equals(provenance.uuid());
        });
    }

    private List<OwnedDrop> visibleOwnedDrops(Minecraft client, String requestedItemId, int radius) {
        if (!inWorld(client)) return List.of();
        LocalPlayer player = client.player;
        List<OwnedDrop> visible = new ArrayList<>();
        for (OwnedDrop provenance : ownedDrops.values()) {
            if (requestedItemId != null && !requestedItemId.equals(provenance.itemId())) continue;
            Entity entity = client.level.getEntity(provenance.entityId());
            if (!(entity instanceof ItemEntity item) || item.isRemoved() || item.getItem().isEmpty()) continue;
            if (!provenance.uuid().isEmpty() && !item.getUUID().toString().equals(provenance.uuid())) continue;
            if (player.distanceTo(item) > radius) continue;
            visible.add(provenance);
        }
        visible.sort(Comparator.comparingDouble(provenance -> {
            Entity entity = client.level.getEntity(provenance.entityId());
            return entity == null ? Double.POSITIVE_INFINITY : player.distanceToSqr(entity);
        }));
        return visible;
    }

    private ItemEntity resolveOwnedTarget(
        Minecraft client,
        LocalPlayer player,
        String requestedItemId,
        int radius,
        Integer preferredEntityId
    ) {
        if (preferredEntityId == null) return null;
        OwnedDrop provenance = ownedDrops.get(preferredEntityId);
        if (provenance == null || (requestedItemId != null && !requestedItemId.equals(provenance.itemId()))) return null;
        Entity entity = client.level.getEntity(preferredEntityId);
        if (!(entity instanceof ItemEntity item) || item.isRemoved() || item.getItem().isEmpty()) {
            ownedDrops.remove(preferredEntityId);
            return null;
        }
        if (!provenance.uuid().isEmpty() && !item.getUUID().toString().equals(provenance.uuid())) {
            ownedDrops.remove(preferredEntityId);
            return null;
        }
        return player.distanceTo(item) <= radius ? item : null;
    }

    private static List<ItemEntity> itemEntitiesNear(Minecraft client, BlockPos position, double radius) {
        return client.level.getEntitiesOfClass(
            ItemEntity.class,
            new AABB(position).inflate(radius),
            item -> item.isAlive() && !item.isRemoved() && !item.getItem().isEmpty()
        );
    }

    private BlockPos findResourceTarget(
        Minecraft client,
        LocalPlayer player,
        ResourceMatcher matcher,
        Set<BlockPos> excluded,
        ApprovedZone zone
    ) {
        BlockPos center = player.blockPosition();
        int radius = 12;
        int minX = Math.max(zone.min().getX(), center.getX() - radius);
        int minY = Math.max(zone.min().getY(), center.getY() - radius);
        int minZ = Math.max(zone.min().getZ(), center.getZ() - radius);
        int maxX = Math.min(zone.max().getX(), center.getX() + radius);
        int maxY = Math.min(zone.max().getY(), center.getY() + radius);
        int maxZ = Math.min(zone.max().getZ(), center.getZ() + radius);
        if (minX > maxX || minY > maxY || minZ > maxZ) return null;

        BlockPos best = null;
        double bestDistance = Double.POSITIVE_INFINITY;
        for (BlockPos mutable : BlockPos.betweenClosed(minX, minY, minZ, maxX, maxY, maxZ)) {
            BlockPos position = mutable.immutable();
            if (excluded.contains(position) || !client.level.isLoaded(position)) continue;
            // Never remove the vertical support column directly below the bot. Falling into the
            // freshly mined hole can strand the pathing loop and is unlike deliberate human play.
            if (position.getX() == center.getX() && position.getZ() == center.getZ()
                && position.getY() <= center.getY()) continue;
            BlockState state = client.level.getBlockState(position);
            if (state.isAir() || state.getDestroySpeed(client.level, position) < 0.0F
                || !matcher.matches(state) || !hasExposedFace(client, position)) continue;
            if (client.level.getBlockEntity(position) != null) continue;
            double distance = player.distanceToSqr(Vec3.atCenterOf(position));
            if (distance < bestDistance) {
                best = position;
                bestDistance = distance;
            }
        }
        return best;
    }

    private static boolean hasExposedFace(Minecraft client, BlockPos position) {
        for (Direction direction : Direction.values()) {
            BlockPos adjacent = position.relative(direction);
            if (!client.level.isLoaded(adjacent)) continue;
            BlockState neighbor = client.level.getBlockState(adjacent);
            if (neighbor.isAir() || neighbor.getCollisionShape(client.level, adjacent).isEmpty()) return true;
        }
        return false;
    }

    private AbstractClientPlayer nearestUnsafePlayer(Minecraft client, LocalPlayer player, BlockPos target, String authorizedPlayer) {
        if (minimumPlayerDistance <= 0.0D) return null;
        Vec3 targetCenter = target == null ? null : Vec3.atCenterOf(target);
        return client.level.players().stream()
            .filter(candidate -> candidate != player && candidate.isAlive())
            .filter(candidate -> authorizedPlayer == null
                || !candidate.getGameProfile().name().equalsIgnoreCase(authorizedPlayer))
            .filter(candidate -> candidate.distanceTo(player) < minimumPlayerDistance
                || (targetCenter != null && candidate.position().distanceTo(targetCenter) < minimumPlayerDistance))
            .min(Comparator.comparingDouble(candidate -> Math.min(
                candidate.distanceTo(player),
                targetCenter == null ? Double.POSITIVE_INFINITY : candidate.position().distanceTo(targetCenter)
            )))
            .orElse(null);
    }

    private String nearbyPlayerCancellationDetail(
        AbstractClientPlayer nearbyPlayer,
        LocalPlayer player,
        BlockPos target
    ) {
        double botDistance = nearbyPlayer.distanceTo(player);
        String targetDistance = target == null
            ? "n/a"
            : String.format(Locale.ROOT, "%.1f", nearbyPlayer.position().distanceTo(Vec3.atCenterOf(target)));
        return "safety_cancelled: player " + nearbyPlayer.getGameProfile().name()
            + " entered wilderness exclusion radius; distance_to_bot="
            + String.format(Locale.ROOT, "%.1f", botDistance)
            + "; distance_to_target=" + targetDistance
            + "; minimum=" + minimumPlayerDistance;
    }

    private record ResourceMatcher(String description, Identifier exactId, TagKey<Block> tag) {
        static ResourceMatcher parse(String resource) {
            String normalized = resource.trim().toLowerCase(Locale.ROOT);
            return switch (normalized) {
                case "wood", "log", "logs", "木头", "原木" -> new ResourceMatcher("#minecraft:logs", null, BlockTags.LOGS);
                case "stone", "石头" -> new ResourceMatcher("#minecraft:base_stone_overworld", null, BlockTags.BASE_STONE_OVERWORLD);
                case "coal", "煤", "煤炭" -> new ResourceMatcher(
                    "#minecraft:coal_ores",
                    null,
                    TagKey.create(Registries.BLOCK, Identifier.parse("minecraft:coal_ores"))
                );
                case "iron", "铁", "铁矿" -> new ResourceMatcher("#minecraft:iron_ores", null, BlockTags.IRON_ORES);
                case "copper", "铜", "铜矿" -> new ResourceMatcher("#minecraft:copper_ores", null, BlockTags.COPPER_ORES);
                case "gold", "金", "金矿" -> new ResourceMatcher("#minecraft:gold_ores", null, BlockTags.GOLD_ORES);
                case "diamond", "钻石", "钻石矿" -> new ResourceMatcher("#minecraft:diamond_ores", null, blockTag("minecraft:diamond_ores"));
                case "lapis", "lapis_lazuli", "青金石", "青金石矿" -> new ResourceMatcher("#minecraft:lapis_ores", null, blockTag("minecraft:lapis_ores"));
                case "redstone", "红石", "红石矿" -> new ResourceMatcher("#minecraft:redstone_ores", null, blockTag("minecraft:redstone_ores"));
                case "emerald", "绿宝石", "绿宝石矿" -> new ResourceMatcher("#minecraft:emerald_ores", null, blockTag("minecraft:emerald_ores"));
                case "obsidian", "黑曜石" -> new ResourceMatcher("minecraft:obsidian", Identifier.parse("minecraft:obsidian"), null);
                case "sugar_cane", "sugar cane", "甘蔗" -> new ResourceMatcher("minecraft:sugar_cane", Identifier.parse("minecraft:sugar_cane"), null);
                default -> {
                    if (normalized.startsWith("#")) {
                        Identifier tagId = Identifier.tryParse(normalized.substring(1));
                        if (tagId == null) throw new IllegalArgumentException("invalid block tag: " + resource);
                        yield new ResourceMatcher("#" + tagId, null, TagKey.create(Registries.BLOCK, tagId));
                    }
                    Identifier blockId = Identifier.tryParse(normalized);
                    if (blockId == null) throw new IllegalArgumentException("invalid block id: " + resource);
                    yield new ResourceMatcher(blockId.toString(), blockId, null);
                }
            };
        }

        boolean matches(BlockState state) {
            return tag != null ? state.is(tag) : BuiltInRegistries.BLOCK.getKey(state.getBlock()).equals(exactId);
        }

        private static TagKey<Block> blockTag(String id) {
            return TagKey.create(Registries.BLOCK, Identifier.parse(id));
        }
    }

    private static RecipeDisplayEntry findCraftableRecipe(
        Minecraft client,
        LocalPlayer player,
        String targetItemId,
        int maximumGrid
    ) {
        StackedItemContents contents = new StackedItemContents();
        player.getInventory().fillStackedContents(contents);
        for (RecipeCollection collection : player.getRecipeBook().getCollections()) {
            for (RecipeDisplayEntry entry : collection.getRecipes()) {
                RecipeDisplay display = entry.display();
                boolean fits = display instanceof ShapedCraftingRecipeDisplay shaped
                    ? shaped.width() <= maximumGrid && shaped.height() <= maximumGrid
                    : display instanceof ShapelessCraftingRecipeDisplay shapeless
                        && shapeless.ingredients().size() <= maximumGrid * maximumGrid;
                boolean requiresExactGrid = maximumGrid == 2
                    ? display instanceof ShapedCraftingRecipeDisplay shaped && shaped.width() <= 2 && shaped.height() <= 2
                        || display instanceof ShapelessCraftingRecipeDisplay shapeless && shapeless.ingredients().size() <= 4
                    : display instanceof ShapedCraftingRecipeDisplay shaped && (shaped.width() > 2 || shaped.height() > 2)
                        || display instanceof ShapelessCraftingRecipeDisplay shapeless && shapeless.ingredients().size() > 4;
                if (!fits || !requiresExactGrid || !entry.canCraft(contents)) continue;
                boolean target = entry.resultItems(SlotDisplayContext.fromLevel(client.level)).stream()
                    .anyMatch(stack -> !stack.isEmpty() && itemId(stack).equals(targetItemId));
                if (target) return entry;
            }
        }
        return null;
    }

    private static BlockPos findCraftingTable(Minecraft client, LocalPlayer player, ApprovedZone zone) {
        BlockPos center = player.blockPosition();
        int radius = 8;
        int minX = Math.max(zone.min().getX(), center.getX() - radius);
        int minY = Math.max(zone.min().getY(), center.getY() - 3);
        int minZ = Math.max(zone.min().getZ(), center.getZ() - radius);
        int maxX = Math.min(zone.max().getX(), center.getX() + radius);
        int maxY = Math.min(zone.max().getY(), center.getY() + 3);
        int maxZ = Math.min(zone.max().getZ(), center.getZ() + radius);
        BlockPos best = null;
        double bestDistance = Double.POSITIVE_INFINITY;
        for (BlockPos cursor : BlockPos.betweenClosed(minX, minY, minZ, maxX, maxY, maxZ)) {
            if (!client.level.isLoaded(cursor) || !client.level.getBlockState(cursor).is(Blocks.CRAFTING_TABLE)
                || !OwnedBlockRegistry.isOwned(client, cursor, "minecraft:crafting_table")) continue;
            double distance = player.distanceToSqr(Vec3.atCenterOf(cursor));
            if (distance < bestDistance) {
                best = cursor.immutable();
                bestDistance = distance;
            }
        }
        return best;
    }

    private void moveToward(Minecraft client, LocalPlayer player, Vec3 target, double stopDistance) {
        navigator.drive(client, player, target, stopDistance, true, tick);
    }

    private static void lookAt(LocalPlayer player, double x, double y, double z) {
        double dx = x - player.getX();
        double dy = y - player.getEyeY();
        double dz = z - player.getZ();
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        player.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
        player.setXRot((float) -Math.toDegrees(Math.atan2(dy, horizontal)));
    }

    private static void clearMovement(Minecraft client) {
        if (client == null) return;
        client.options.keyUp.setDown(false);
        client.options.keyDown.setDown(false);
        client.options.keyLeft.setDown(false);
        client.options.keyRight.setDown(false);
        client.options.keyJump.setDown(false);
        client.options.keySprint.setDown(false);
        client.options.keyShift.setDown(false);
    }

    private static void clearTaskControls(Minecraft client) {
        clearMovement(client);
        if (client == null) return;
        client.options.keyUse.setDown(false);
        client.options.keyAttack.setDown(false);
    }
}
