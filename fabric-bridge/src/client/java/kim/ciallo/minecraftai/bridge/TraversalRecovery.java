package kim.ciallo.minecraftai.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Set;

/**
 * Last-resort terrain recovery for a persistent route. It may only break blocks that pass
 * the hard natural-block guard, or place an owned disposable bridge in verified wilderness.
 */
final class TraversalRecovery {
    private static final Set<String> BRIDGE_MATERIALS = Set.of(
        "minecraft:cobblestone", "minecraft:cobbled_deepslate", "minecraft:dirt",
        "minecraft:coarse_dirt", "minecraft:netherrack", "minecraft:end_stone"
    );
    private BlockPos breaking;
    private long breakingStarted;
    private boolean breakStarted;
    private BlockPos placing;
    private String placingBlockId;
    private long placingStarted;
    private long lastPlaceAttempt;
    private boolean placingInWater;
    private String status = "idle";

    boolean active() { return breaking != null || placing != null; }
    String status() { return status; }

    void reset(Minecraft client) {
        if (client != null && client.gameMode != null && breaking != null) client.gameMode.stopDestroyBlock();
        breaking = null;
        placing = null;
        placingBlockId = null;
        placingInWater = false;
        breakStarted = false;
        status = "idle";
    }

    /** Returns true while recovery owns this tick. */
    boolean tick(Minecraft client, LocalPlayer player, Vec3 goal, int planFailures, long tick) {
        if (client == null || client.level == null || client.gameMode == null || player == null || goal == null) {
            reset(client);
            return false;
        }
        if (breaking != null) return continueBreaking(client, player, tick);
        if (placing != null) return continuePlacing(client, player, tick);
        if (planFailures < 8) return false;

        Direction direction = horizontalDirection(player.position(), goal);
        List<Direction> directions = orderedDirections(direction);

        if (player.isInWater()) {
            BlockPos waterStep = waterEgressStep(client, player, directions);
            if (waterStep != null && beginPlacement(player, waterStep, tick, true)) {
                status = "preparing_water_egress_step";
                return continuePlacing(client, player, tick);
            }
        }

        for (Direction candidateDirection : directions) {
            BlockPos ahead = player.blockPosition().relative(candidateDirection);
            for (BlockPos candidate : List.of(ahead, ahead.above())) {
                BlockState state = client.level.getBlockState(candidate);
                if (state.isAir() || state.canBeReplaced()) continue;
                if (state.getDestroySpeed(client.level, candidate) < 0.0F
                    || !WildernessGuard.safeNaturalBreak(client, candidate)
                    || dangerousFluidAdjacent(client, candidate)
                    || player.distanceToSqr(Vec3.atCenterOf(candidate)) > 25.0D) continue;
                breaking = candidate.immutable();
                breakingStarted = tick;
                breakStarted = false;
                status = "preparing_natural_obstacle_break_" + candidateDirection.getName();
                return continueBreaking(client, player, tick);
            }

            BlockPos support = ahead.below();
            BlockState supportState = client.level.getBlockState(support);
            BlockState feetState = client.level.getBlockState(ahead);
            BlockState headState = client.level.getBlockState(ahead.above());
            boolean gap = supportState.canBeReplaced() && supportState.getFluidState().isEmpty();
            boolean bodyClear = feetState.getCollisionShape(client.level, ahead).isEmpty()
                && headState.getCollisionShape(client.level, ahead.above()).isEmpty()
                && feetState.getFluidState().isEmpty() && headState.getFluidState().isEmpty();
            if (gap && bodyClear && player.distanceToSqr(Vec3.atCenterOf(support)) <= 25.0D
                && WildernessGuard.safePlacementArea(client, support, 3)
                && beginPlacement(player, support, tick, false)) {
                status = "preparing_owned_bridge_" + candidateDirection.getName();
                return continuePlacing(client, player, tick);
            }
        }
        status = "no_safe_terrain_recovery";
        return false;
    }

    private boolean continueBreaking(Minecraft client, LocalPlayer player, long tick) {
        BlockState state = client.level.getBlockState(breaking);
        if (state.isAir()) {
            client.gameMode.stopDestroyBlock();
            breaking = null;
            breakStarted = false;
            status = "natural_obstacle_removed";
            return true;
        }
        if (!WildernessGuard.safeNaturalBreak(client, breaking) || dangerousFluidAdjacent(client, breaking)
            || player.distanceToSqr(Vec3.atCenterOf(breaking)) > 25.0D || tick - breakingStarted > 240L) {
            reset(client);
            status = "obstacle_recovery_cancelled_by_safety";
            return false;
        }
        if (!ToolSelector.ensureBestMiningTool(client, player, state)) {
            status = "swapping_correct_obstacle_tool";
            return true;
        }
        lookAt(player, Vec3.atCenterOf(breaking));
        if (!breakStarted) {
            client.gameMode.startDestroyBlock(breaking, Direction.UP);
            breakStarted = true;
        } else client.gameMode.continueDestroyBlock(breaking, Direction.UP);
        player.swing(InteractionHand.MAIN_HAND);
        status = "breaking_verified_natural_obstacle";
        return true;
    }

    private boolean continuePlacing(Minecraft client, LocalPlayer player, long tick) {
        BlockState observed = client.level.getBlockState(placing);
        String observedId = blockId(observed);
        if (placingBlockId.equals(observedId) && !observed.canBeReplaced()) {
            OwnedBlockRegistry.registerPlacedStructure(client, placing, observedId);
            placing = null;
            placingBlockId = null;
            placingInWater = false;
            status = "owned_bridge_confirmed";
            return true;
        }
        boolean allowedFluid = placingInWater && observed.getFluidState().is(FluidTags.WATER);
        if (!observed.canBeReplaced() || (!observed.getFluidState().isEmpty() && !allowedFluid)
            || !WildernessGuard.safePlacementArea(client, placing, 3) || tick - placingStarted > 100L) {
            reset(client);
            status = "bridge_recovery_cancelled_by_safety";
            return false;
        }
        BridgeChoice choice = bestBridgeChoice(player);
        if (choice == null || !choice.blockId().equals(placingBlockId)) {
            reset(client);
            status = "bridge_material_lost";
            return false;
        }
        if (!ensureSelected(client, player, choice)) {
            status = "swapping_bridge_material";
            return true;
        }
        if (tick - lastPlaceAttempt >= 8L) {
            if (!placeHeldBlockAt(client, player, placing)) {
                reset(client);
                status = "bridge_has_no_legal_support_face";
                return false;
            }
            lastPlaceAttempt = tick;
        }
        status = placingInWater ? "placing_owned_water_egress_step" : "placing_owned_bridge";
        return true;
    }

    private boolean beginPlacement(LocalPlayer player, BlockPos target, long tick, boolean water) {
        BridgeChoice choice = bestBridgeChoice(player);
        if (choice == null) { status = "bridge_material_unavailable"; return false; }
        placing = target.immutable();
        placingBlockId = choice.blockId();
        placingStarted = tick;
        lastPlaceAttempt = Long.MIN_VALUE;
        placingInWater = water;
        return true;
    }

    private static BlockPos waterEgressStep(Minecraft client, LocalPlayer player, List<Direction> directions) {
        BlockPos feet = player.blockPosition();
        for (Direction direction : directions) {
            BlockPos bankSupport = feet.relative(direction).below();
            if (replaceableWater(client, bankSupport) && hasLegalSupportFace(client, bankSupport)
                && player.distanceToSqr(Vec3.atCenterOf(bankSupport)) <= 25.0D
                && WildernessGuard.safePlacementArea(client, bankSupport, 3)) return bankSupport.immutable();
        }
        for (int depth = 1; depth <= 4; depth++) {
            BlockPos below = feet.below(depth);
            if (replaceableWater(client, below) && hasLegalSupportFace(client, below)
                && player.distanceToSqr(Vec3.atCenterOf(below)) <= 25.0D
                && WildernessGuard.safePlacementArea(client, below, 3)) return below.immutable();
        }
        return null;
    }

    private static boolean replaceableWater(Minecraft client, BlockPos position) {
        if (!client.level.isLoaded(position)) return false;
        BlockState state = client.level.getBlockState(position);
        return state.canBeReplaced() && state.getFluidState().is(FluidTags.WATER);
    }

    private static boolean hasLegalSupportFace(Minecraft client, BlockPos target) {
        for (Direction face : Direction.values()) {
            BlockPos support = target.relative(face);
            if (!client.level.isLoaded(support)) continue;
            BlockState state = client.level.getBlockState(support);
            if (!state.canBeReplaced() && !state.getCollisionShape(client.level, support).isEmpty()) return true;
        }
        return false;
    }

    private static BridgeChoice bestBridgeChoice(LocalPlayer player) {
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        for (int slot = 0; slot < items.size() && slot < Inventory.INVENTORY_SIZE; slot++) {
            ItemStack stack = items.get(slot);
            if (!(stack.getItem() instanceof BlockItem blockItem) || stack.isEmpty()) continue;
            String blockId = BuiltInRegistries.BLOCK.getKey(blockItem.getBlock()).toString();
            if (BRIDGE_MATERIALS.contains(blockId)) return new BridgeChoice(slot, blockId);
        }
        return null;
    }

    private static boolean ensureSelected(Minecraft client, LocalPlayer player, BridgeChoice choice) {
        if (Inventory.isHotbarSlot(choice.slot())) {
            if (player.getInventory().getSelectedSlot() != choice.slot()) {
                player.getInventory().setSelectedSlot(choice.slot());
                player.connection.send(new ServerboundSetCarriedItemPacket(choice.slot()));
            }
            return true;
        }
        if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) return false;
        int destination = player.getInventory().getSelectedSlot();
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            if (player.getInventory().getItem(slot).isEmpty()) { destination = slot; break; }
        }
        client.gameMode.handleContainerInput(player.inventoryMenu.containerId, choice.slot(), destination, ContainerInput.SWAP, player);
        return false;
    }

    private static boolean placeHeldBlockAt(Minecraft client, LocalPlayer player, BlockPos target) {
        for (Direction face : List.of(Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST, Direction.DOWN)) {
            BlockPos support = target.relative(face.getOpposite());
            if (!client.level.isLoaded(support)) continue;
            BlockState supportState = client.level.getBlockState(support);
            if (supportState.canBeReplaced() || supportState.getCollisionShape(client.level, support).isEmpty()) continue;
            Vec3 hit = Vec3.atCenterOf(support).add(face.getStepX() * 0.5D, face.getStepY() * 0.5D, face.getStepZ() * 0.5D);
            lookAt(player, hit);
            client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, new BlockHitResult(hit, face, support, false));
            player.swing(InteractionHand.MAIN_HAND);
            return true;
        }
        return false;
    }

    private static boolean dangerousFluidAdjacent(Minecraft client, BlockPos position) {
        for (Direction direction : Direction.values()) {
            BlockState neighbor = client.level.getBlockState(position.relative(direction));
            if (!neighbor.getFluidState().isEmpty()) return true;
        }
        return false;
    }

    private static Direction horizontalDirection(Vec3 from, Vec3 to) {
        double dx = to.x - from.x;
        double dz = to.z - from.z;
        if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0.0D ? Direction.EAST : Direction.WEST;
        return dz >= 0.0D ? Direction.SOUTH : Direction.NORTH;
    }

    private static List<Direction> orderedDirections(Direction primary) {
        return List.of(primary, primary.getClockWise(), primary.getCounterClockWise(), primary.getOpposite());
    }

    private static void lookAt(LocalPlayer player, Vec3 target) {
        double dx = target.x - player.getX();
        double dy = target.y - player.getEyeY();
        double dz = target.z - player.getZ();
        double horizontal = Math.max(0.001D, Math.sqrt(dx * dx + dz * dz));
        player.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
        player.setXRot((float) -Math.toDegrees(Math.atan2(dy, horizontal)));
    }

    private static String blockId(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    private record BridgeChoice(int slot, String blockId) { }
}
