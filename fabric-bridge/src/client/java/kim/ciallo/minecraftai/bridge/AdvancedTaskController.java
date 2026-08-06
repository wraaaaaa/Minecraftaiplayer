package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundSelectTradePacket;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.AgeableMob;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Leashable;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.npc.villager.AbstractVillager;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.AbstractFurnaceMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.EnchantmentMenu;
import net.minecraft.world.inventory.MerchantMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.trading.MerchantOffer;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EndPortalFrameBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Tick-driven survival primitives that require entities, containers, or multi-block movement. */
public final class AdvancedTaskController {
    private static final int HUNT_TIMEOUT_TICKS = 4_800;
    private static final int SMELT_TIMEOUT_TICKS = 7_200;
    private static final int CONTAINER_TIMEOUT_TICKS = 1_200;
    private static final int EXCAVATE_TIMEOUT_TICKS = 7_200;
    private static final int EXPLORE_TIMEOUT_TICKS = 4_800;
    private static final int TRAVEL_TIMEOUT_TICKS = 36_000;

    public record TaskResult(String id, boolean ok, String detail) { }

    private final PrimitiveTaskController primitives;
    private final ArrayDeque<TaskResult> results = new ArrayDeque<>();
    private final LocalPathNavigator navigator = new LocalPathNavigator();
    private Task active;
    private long tick;
    private double minimumPlayerDistance = 48.0D;
    private int frontierSequence;

    public AdvancedTaskController(PrimitiveTaskController primitives) {
        this.primitives = primitives;
    }

    public void setMinimumPlayerDistance(double distance) {
        minimumPlayerDistance = Math.max(0.0D, Math.min(512.0D, distance));
    }

    public boolean start(String id, JsonObject action, Minecraft client) {
        if (id == null || id.isBlank()) return false;
        if (active != null) {
            results.add(new TaskResult(id, false, "busy: active advanced task is " + active.type));
            return false;
        }
        if (!inWorld(client)) {
            results.add(new TaskResult(id, false, "not_in_world"));
            return false;
        }
        String type = string(action, "type", "");
        try {
            active = switch (type) {
                case "hunt_entity" -> new HuntTask(id, action);
                case "attack_hostile" -> new DefendTask(id, action);
                case "smelt_item" -> new SmeltTask(id, action, client.player);
                case "trade_villager" -> new TradeTask(id, action, client.player);
                case "enchant_item" -> new EnchantTask(id, action, client.player);
                case "sleep_in_bed" -> new SleepTask(id);
                case "excavate_tunnel" -> new ExcavateTask(id, action, client);
                case "explore_frontier" -> new ExploreTask(id, action, client.player);
                case "build_nether_portal" -> new PortalBuildTask(id, action, client);
                case "travel_to_dimension" -> new TravelTask(id, action);
                default -> null;
            };
        } catch (IllegalArgumentException error) {
            results.add(new TaskResult(id, false, "invalid_action: " + error.getMessage()));
            return false;
        }
        if (active == null) {
            results.add(new TaskResult(id, false, "unsupported advanced task: " + type));
            return false;
        }
        return true;
    }

    public void tick(Minecraft client) {
        tick++;
        Task task = active;
        if (task == null) return;
        if (!inWorld(client)) {
            finish(client, task, false, "not_in_world");
            return;
        }
        if (tick - task.startedTick > task.timeoutTicks) {
            finish(client, task, false, "timeout: " + task.type + "; navigation=" + navigator.status());
            return;
        }
        try {
            task.tick(client);
        } catch (Exception error) {
            finish(client, task, false, "exception: " + error.getClass().getSimpleName() + ": " + safeMessage(error));
        }
    }

    public boolean cancel(Minecraft client, String detail) {
        if (active == null) return false;
        finish(client, active, false, detail == null || detail.isBlank() ? "cancelled" : detail);
        return true;
    }

    public List<TaskResult> drainResults() {
        List<TaskResult> output = new ArrayList<>(results);
        results.clear();
        return output;
    }

    public String activeType() { return active == null ? "" : active.type; }
    public String navigationStatus() {
        return active instanceof ExcavateTask excavation
            ? navigator.status() + "; " + excavation.debugStatus()
            : navigator.status();
    }

    private abstract class Task {
        final String id;
        final String type;
        final long startedTick = tick;
        final int timeoutTicks;

        Task(String id, String type, int timeoutTicks) {
            this.id = id;
            this.type = type;
            this.timeoutTicks = timeoutTicks;
        }

        abstract void tick(Minecraft client);

        void cleanup(Minecraft client) {
            navigator.release(client);
            clearControls(client);
            if (client != null && client.player != null && client.player.containerMenu != client.player.inventoryMenu) {
                client.player.closeContainer();
            }
        }
    }

    private final class HuntTask extends Task {
        private final String purpose;
        private final int wanted;
        private final int baseline;
        private LivingEntity target;
        private Vec3 lastDeathPosition;
        private long lastAttackTick;

        HuntTask(String id, JsonObject action) {
            super(id, "hunt_entity", HUNT_TIMEOUT_TICKS);
            purpose = string(action, "purpose", "food").toLowerCase(Locale.ROOT);
            if (!Set.of("food", "wool", "leather", "ender_pearl", "blaze_rod").contains(purpose)) {
                throw new IllegalArgumentException("unknown hunt purpose " + purpose);
            }
            wanted = integer(action, "count", 1, 64, 1);
            baseline = purposeInventoryCount(Minecraft.getInstance().player, purpose);
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            int collected = purposeInventoryCount(player, purpose) - baseline;
            if (collected >= wanted) {
                finish(client, this, true, "verified_hunt_drop_inventory_delta=" + collected + "; purpose=" + purpose);
                return;
            }
            if (player.getHealth() <= 6.0F || player.isInLava() || player.isOnFire()) {
                finish(client, this, false, "self_preservation_cancelled: health=" + player.getHealth());
                return;
            }

            ItemEntity drop = nearestPurposeDrop(client, player, purpose, lastDeathPosition);
            if (drop != null) {
                primitives.registerOwnedDrop(drop);
                if (player.distanceTo(drop) > 1.4D) {
                    if (!navigator.drive(client, player, drop.position(), 1.0D, true, tick)
                        && navigator.consecutivePlanFailures() >= 12) {
                        finish(client, this, false, "no_safe_route_to_hunt_drop: " + purpose);
                    }
                    return;
                }
            }

            if (target == null || !target.isAlive() || target.isRemoved()) {
                if (target != null) lastDeathPosition = target.position();
                target = findHuntTarget(client, player, purpose);
                if (target == null) {
                    if (tick - startedTick > 80L) finish(client, this, false, "no_safe_loaded_hunt_target: " + purpose);
                    return;
                }
            }

            double distance = player.distanceTo(target);
            if (distance > 2.7D || !player.hasLineOfSight(target)) {
                if (!navigator.drive(client, player, target.position(), 2.1D, distance > 6.0D, tick)
                    && navigator.consecutivePlanFailures() >= 12) {
                    finish(client, this, false, "no_safe_route_to_hunt_target: " + purpose
                        + "; target=" + target.getId());
                }
                return;
            }
            navigator.release(client);
            lookAt(player, target.getX(), target.getEyeY(), target.getZ());
            if (tick - lastAttackTick < 8L || player.getAttackStrengthScale(0.5F) < 0.9F) return;
            if (!player.canAttack(target) || !player.isWithinAttackRange(player.getInventory().getSelectedItem(), target.getBoundingBox(), 0.0D)) return;
            client.gameMode.attack(player, target);
            player.swing(InteractionHand.MAIN_HAND);
            lastAttackTick = tick;
        }
    }

    private final class DefendTask extends Task {
        private final int requestedEntityId;
        private final String protectPlayer;
        private LivingEntity target;
        private long lastAttackTick;

        DefendTask(String id, JsonObject action) {
            super(id, "attack_hostile", HUNT_TIMEOUT_TICKS);
            requestedEntityId = integer(action, "targetId", -1, Integer.MAX_VALUE, -1);
            protectPlayer = string(action, "protectPlayer", "");
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (target == null || !target.isAlive() || target.isRemoved()) target = findHostile(client, player, requestedEntityId, protectPlayer);
            if (target == null) {
                finish(client, this, true, "threat_no_longer_present");
                return;
            }
            if (player.getHealth() <= 6.0F) {
                finish(client, this, false, "self_preservation_cancelled: low_health");
                return;
            }
            double distance = player.distanceTo(target);
            if (distance > 2.8D || !player.hasLineOfSight(target)) {
                navigator.drive(client, player, target.position(), 2.1D, distance > 6.0D, tick);
                return;
            }
            navigator.release(client);
            lookAt(player, target.getX(), target.getEyeY(), target.getZ());
            if (tick - lastAttackTick < 8L || player.getAttackStrengthScale(0.5F) < 0.9F) return;
            client.gameMode.attack(player, target);
            player.swing(InteractionHand.MAIN_HAND);
            lastAttackTick = tick;
            if (protectPlayer.isBlank()) finish(client, this, true, "verified_hostile_attack_sent=" + target.getId());
        }
    }

    private final class SmeltTask extends Task {
        private enum Phase { FIND, OPEN, LOAD_INPUT, LOAD_FUEL, WAIT_OUTPUT, TAKE_OUTPUT, VERIFY }
        private final String inputId;
        private final String outputId;
        private final int wanted;
        private final int baseline;
        private BlockPos furnace;
        private Phase phase = Phase.FIND;
        private long phaseTick;

        SmeltTask(String id, JsonObject action, LocalPlayer player) {
            super(id, "smelt_item", SMELT_TIMEOUT_TICKS);
            inputId = normalizeId(required(action, "inputItemId"));
            outputId = normalizeId(string(action, "outputItemId", inferredSmeltOutput(inputId)));
            wanted = Math.min(integer(action, "count", 1, 64, 1), inventoryCount(player, inputId));
            if (wanted <= 0) throw new IllegalArgumentException("input is not in inventory: " + inputId);
            baseline = inventoryCount(player, outputId);
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (phase == Phase.FIND) {
                furnace = findOwnedBlock(client, player.blockPosition(), 12, state -> state.is(Blocks.FURNACE));
                if (furnace == null) {
                    finish(client, this, false, "no_loaded_bot_owned_furnace; craft and place one first");
                    return;
                }
                phase = Phase.OPEN;
            }
            if (phase == Phase.OPEN) {
                if (player.distanceToSqr(Vec3.atCenterOf(furnace)) > 16.0D) {
                    navigator.drive(client, player, Vec3.atCenterOf(furnace), 2.5D, true, tick);
                    return;
                }
                navigator.release(client);
                if (player.containerMenu instanceof AbstractFurnaceMenu) {
                    phase = Phase.LOAD_INPUT;
                    return;
                }
                if (tick - phaseTick > 10L) {
                    useBlock(client, player, furnace);
                    phaseTick = tick;
                }
                return;
            }
            if (!(player.containerMenu instanceof AbstractFurnaceMenu menu)) {
                finish(client, this, false, "furnace_menu_closed_before_completion");
                return;
            }
            if (phase == Phase.LOAD_INPUT) {
                if (menu.getSlot(0).getItem().isEmpty()) {
                    int source = findPlayerMenuSlot(menu, inputId);
                    if (source < 0) { finish(client, this, false, "smelt_input_missing_after_open"); return; }
                    quickMove(client, player, menu, source);
                    phaseTick = tick;
                    return;
                }
                phase = Phase.LOAD_FUEL;
            }
            if (phase == Phase.LOAD_FUEL) {
                if (menu.getSlot(1).getItem().isEmpty() && !menu.isLit()) {
                    int fuelSlot = findFuelMenuSlot(menu);
                    if (fuelSlot < 0) { finish(client, this, false, "no_furnace_fuel_in_inventory"); return; }
                    quickMove(client, player, menu, fuelSlot);
                    phaseTick = tick;
                    return;
                }
                phase = Phase.WAIT_OUTPUT;
            }
            if (phase == Phase.WAIT_OUTPUT) {
                ItemStack result = menu.getSlot(2).getItem();
                if (!result.isEmpty() && itemId(result).equals(outputId)
                    && (result.getCount() >= wanted || menu.getSlot(0).getItem().isEmpty())) {
                    phase = Phase.TAKE_OUTPUT;
                } else if (tick - phaseTick > wanted * 240L + 200L) {
                    finish(client, this, false, "furnace did not produce expected output " + outputId);
                }
                return;
            }
            if (phase == Phase.TAKE_OUTPUT) {
                quickMove(client, player, menu, 2);
                phase = Phase.VERIFY;
                phaseTick = tick;
                return;
            }
            int delta = inventoryCount(player, outputId) - baseline;
            if (delta >= wanted || (delta > 0 && tick - phaseTick > 20L)) {
                finish(client, this, true, "verified_smelt_inventory_delta=" + delta + "; output=" + outputId);
            } else if (tick - phaseTick > 60L) {
                finish(client, this, false, "server did not confirm smelt output inventory delta");
            }
        }
    }

    private final class TradeTask extends Task {
        private enum Phase { FIND, OPEN, SELECT, TAKE, VERIFY }
        private final String desired;
        private final int wanted;
        private AbstractVillager villager;
        private Phase phase = Phase.FIND;
        private int offerIndex = -1;
        private String resultId;
        private int baseline;
        private long phaseTick;

        TradeTask(String id, JsonObject action, LocalPlayer player) {
            super(id, "trade_villager", CONTAINER_TIMEOUT_TICKS);
            desired = optionalId(action, "desiredItemId");
            wanted = integer(action, "count", 1, 16, 1);
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (phase == Phase.FIND) {
                villager = nearestVillager(client, player);
                if (villager == null) { finish(client, this, false, "no_loaded_adult_villager"); return; }
                phase = Phase.OPEN;
            }
            if (phase == Phase.OPEN) {
                if (player.distanceTo(villager) > 3.0D) {
                    navigator.drive(client, player, villager.position(), 2.4D, true, tick);
                    return;
                }
                navigator.release(client);
                if (player.containerMenu instanceof MerchantMenu) { phase = Phase.SELECT; return; }
                if (tick - phaseTick > 10L) {
                    client.gameMode.interact(player, villager, new EntityHitResult(villager), InteractionHand.MAIN_HAND);
                    phaseTick = tick;
                }
                return;
            }
            if (!(player.containerMenu instanceof MerchantMenu menu)) {
                finish(client, this, false, "merchant_menu_closed_before_completion");
                return;
            }
            if (phase == Phase.SELECT) {
                offerIndex = chooseOffer(menu, player, desired);
                if (offerIndex < 0) { finish(client, this, false, "no_affordable_safe_trade_matching_request"); return; }
                MerchantOffer offer = menu.getOffers().get(offerIndex);
                resultId = itemId(offer.getResult());
                baseline = inventoryCount(player, resultId);
                menu.setSelectionHint(offerIndex);
                player.connection.send(new ServerboundSelectTradePacket(offerIndex));
                menu.tryMoveItems(offerIndex);
                phase = Phase.TAKE;
                phaseTick = tick;
                return;
            }
            if (phase == Phase.TAKE) {
                if (!menu.getSlot(2).getItem().isEmpty()) {
                    quickMove(client, player, menu, 2);
                    phase = Phase.VERIFY;
                    phaseTick = tick;
                } else if (tick - phaseTick > 80L) finish(client, this, false, "server did not populate merchant result slot");
                return;
            }
            int delta = inventoryCount(player, resultId) - baseline;
            if (delta >= wanted || delta > 0) finish(client, this, true, "verified_trade_inventory_delta=" + delta + "; result=" + resultId);
            else if (tick - phaseTick > 60L) finish(client, this, false, "server did not confirm traded item in inventory");
        }
    }

    private final class EnchantTask extends Task {
        private enum Phase { FIND, OPEN, LOAD_ITEM, LOAD_LAPIS, CHOOSE, TAKE, VERIFY }
        private final String requestedItem;
        private final int minimumLevel;
        private BlockPos table;
        private Phase phase = Phase.FIND;
        private String itemId;
        private long phaseTick;

        EnchantTask(String id, JsonObject action, LocalPlayer player) {
            super(id, "enchant_item", CONTAINER_TIMEOUT_TICKS);
            requestedItem = optionalId(action, "itemId");
            minimumLevel = integer(action, "minLevel", 1, 30, 1);
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (phase == Phase.FIND) {
                table = findOwnedBlock(client, player.blockPosition(), 12, state -> state.is(Blocks.ENCHANTING_TABLE));
                if (table == null) { finish(client, this, false, "no_loaded_bot_owned_enchanting_table"); return; }
                itemId = chooseEnchantableItem(player, requestedItem);
                if (itemId == null) { finish(client, this, false, "no_unenchanted_damageable_item_matching_request"); return; }
                if (inventoryCount(player, "minecraft:lapis_lazuli") <= 0 || player.experienceLevel < minimumLevel) {
                    finish(client, this, false, "insufficient_lapis_or_experience");
                    return;
                }
                phase = Phase.OPEN;
            }
            if (phase == Phase.OPEN) {
                if (player.distanceToSqr(Vec3.atCenterOf(table)) > 16.0D) {
                    navigator.drive(client, player, Vec3.atCenterOf(table), 2.5D, true, tick);
                    return;
                }
                navigator.release(client);
                if (player.containerMenu instanceof EnchantmentMenu) { phase = Phase.LOAD_ITEM; return; }
                if (tick - phaseTick > 10L) { useBlock(client, player, table); phaseTick = tick; }
                return;
            }
            if (!(player.containerMenu instanceof EnchantmentMenu menu)) {
                finish(client, this, false, "enchantment_menu_closed_before_completion");
                return;
            }
            if (phase == Phase.LOAD_ITEM) {
                if (menu.getSlot(0).getItem().isEmpty()) {
                    int source = findPlayerMenuSlot(menu, itemId);
                    if (source < 0) { finish(client, this, false, "enchant_item_missing_after_open"); return; }
                    quickMove(client, player, menu, source);
                    phaseTick = tick;
                    return;
                }
                phase = Phase.LOAD_LAPIS;
            }
            if (phase == Phase.LOAD_LAPIS) {
                if (menu.getSlot(1).getItem().isEmpty()) {
                    int source = findPlayerMenuSlot(menu, "minecraft:lapis_lazuli");
                    if (source < 0) { finish(client, this, false, "lapis_missing_after_open"); return; }
                    quickMove(client, player, menu, source);
                    phaseTick = tick;
                    return;
                }
                phase = Phase.CHOOSE;
            }
            if (phase == Phase.CHOOSE) {
                int option = -1;
                for (int index = 2; index >= 0; index--) {
                    int cost = menu.costs[index];
                    if (cost > 0 && cost <= player.experienceLevel && index + 1 <= menu.getGoldCount()) { option = index; break; }
                }
                if (option < 0) {
                    if (tick - phaseTick > 40L) finish(client, this, false, "no_affordable_enchantment_option");
                    return;
                }
                client.gameMode.handleInventoryButtonClick(menu.containerId, option);
                phase = Phase.TAKE;
                phaseTick = tick;
                return;
            }
            if (phase == Phase.TAKE) {
                ItemStack enchanted = menu.getSlot(0).getItem();
                if (!enchanted.isEmpty() && !enchanted.getEnchantments().isEmpty()) {
                    quickMove(client, player, menu, 0);
                    phase = Phase.VERIFY;
                    phaseTick = tick;
                } else if (tick - phaseTick > 80L) finish(client, this, false, "server did not apply an enchantment");
                return;
            }
            boolean verified = player.getInventory().getNonEquipmentItems().stream()
                .anyMatch(stack -> !stack.isEmpty() && itemId(stack).equals(itemId) && !stack.getEnchantments().isEmpty());
            if (verified) finish(client, this, true, "verified_enchanted_item=" + itemId);
            else if (tick - phaseTick > 60L) finish(client, this, false, "enchanted item did not return to inventory");
        }
    }

    private final class SleepTask extends Task {
        private BlockPos bed;
        private long interactionTick;

        SleepTask(String id) { super(id, "sleep_in_bed", CONTAINER_TIMEOUT_TICKS); }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (player.isSleeping()) {
                finish(client, this, true, "verified_player_sleeping; server will set bed respawn point");
                return;
            }
            if (bed == null) {
                bed = findOwnedBlock(client, player.blockPosition(), 16, state -> state.is(BlockTags.BEDS));
                if (bed == null) { finish(client, this, false, "no_loaded_bot_owned_bed"); return; }
            }
            if (player.distanceToSqr(Vec3.atCenterOf(bed)) > 12.25D) {
                navigator.drive(client, player, Vec3.atCenterOf(bed), 2.2D, true, tick);
                return;
            }
            navigator.release(client);
            if (tick - interactionTick > 20L) {
                useBlock(client, player, bed);
                interactionTick = tick;
            }
            if (tick - startedTick > 160L) finish(client, this, false, "server did not confirm sleeping; it may be daytime, obstructed, or unsafe");
        }
    }

    private final class ExcavateTask extends Task {
        private final int targetY;
        private final int length;
        private final int startY;
        private final int terminalY;
        private final int verticalDirection;
        private Direction direction;
        private final String resource;
        private final int resourceBaseline;
        private int completed;
        private int brokenBlocks;
        private int placedSupports;
        private BlockPos stepGoal;
        private final ArrayDeque<BlockPos> breakQueue = new ArrayDeque<>();
        private BlockPos breaking;
        private long breakStarted;
        private BlockPos scaffold;
        private String scaffoldItem;
        private long scaffoldStarted;
        private long scaffoldLastAttempt;
        private long lastVerifiedProgressTick;

        ExcavateTask(String id, JsonObject action, Minecraft client) {
            super(id, "excavate_tunnel", EXCAVATE_TIMEOUT_TICKS);
            if (!booleanValue(action, "verifiedWilderness", false) && primitives.approvedZone() == null) {
                throw new IllegalArgumentException("excavate_tunnel requires verified wilderness or an approved zone");
            }
            targetY = integer(action, "targetY", client.level.getMinY() + 5, client.level.getMaxY() - 5, -53);
            length = integer(action, "length", 2, 64, 12);
            startY = navigator.standingBlockPos(client, client.player).getY();
            verticalDirection = Integer.compare(targetY, startY);
            terminalY = verticalDirection > 0
                ? Math.min(targetY, startY + length)
                : verticalDirection < 0 ? Math.max(targetY, startY - length) : startY;
            resource = string(action, "resource", "stone").toLowerCase(Locale.ROOT);
            resourceBaseline = resourceInventoryCount(client.player, resource);
            lastVerifiedProgressTick = startedTick;
            direction = chooseExcavationDirection(client, client.player, targetY);
            if (direction == null && targetY > startY) {
                direction = chooseScaffoldDirection(client, client.player);
            }
            if (direction == null) throw new IllegalArgumentException("no safe natural direction for the first excavation segment; "
                + excavationDirectionReport(client, client.player, targetY));
            // Every broken block is verified below. Nearby structures must not turn unrelated
            // natural stone or ore into an artificial global no-mining zone.
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (player.getHealth() <= 8.0F || player.isInLava() || player.getAirSupply() < player.getMaxAirSupply() / 2) {
                finish(client, this, false, "excavation self-preservation stop");
                return;
            }
            if (tick - lastVerifiedProgressTick > 500L) {
                finish(client, this, false, "excavation_stalled_without_verified_progress; " + debugStatus());
                return;
            }
            BlockPos standing = navigator.standingBlockPos(client, player);
            int currentY = standing.getY();
            boolean stable = player.onGround() || player.isInWater();
            boolean reachedTerminal = verticalDirection > 0
                ? stable && currentY >= terminalY
                : verticalDirection < 0 ? stable && currentY <= terminalY : completed >= length;
            if (reachedTerminal) {
                int resourceDelta = Math.max(0, resourceInventoryCount(player, resource) - resourceBaseline);
                finish(client, this, true, "verified_tunnel_steps=" + completed
                    + "; verified_broken_blocks=" + brokenBlocks
                    + "; verified_support_blocks=" + placedSupports
                    + "; resource=" + resource
                    + "; inventory_delta=" + resourceDelta
                    + "; final_y=" + currentY);
                return;
            }
            if (scaffold != null) {
                continueScaffold(client, player);
                return;
            }
            if (breaking != null) {
                continueBreaking(client, player);
                return;
            }
            if (!breakQueue.isEmpty()) {
                breaking = breakQueue.removeFirst();
                breakStarted = tick;
                continueBreaking(client, player);
                return;
            }
            if (stepGoal == null) prepareNextStep(client, player);
            if (active != this) return;
            if (stepGoal == null) return;
            BlockPos feet = standing;
            if (stable && verticalDirection != 0 && Math.abs(stepGoal.getY() - feet.getY()) > 1) {
                // The Bot slid or fell off a completed stair. Discard the now unreachable stale
                // goal and continue from the real landing cell instead of repeatedly walking into
                // the wall below it.
                stepGoal = null;
                navigator.release(client);
                return;
            }
            double stepDx = player.getX() - (stepGoal.getX() + 0.5D);
            double stepDz = player.getZ() - (stepGoal.getZ() + 0.5D);
            // A jump briefly raises blockPosition before the server confirms a landing. Counting
            // that airborne tick as a completed stair made the next goal two blocks above the
            // real floor, after which the Bot fell back and A* correctly refused the impossible
            // jump. Only persist progress once grounded (water movement is handled separately).
            boolean verifiedGoalY = feet.getY() == stepGoal.getY()
                || Math.abs(player.getY() - stepGoal.getY()) <= 0.25D;
            if ((player.onGround() || player.isInWater())
                && verifiedGoalY && stepDx * stepDx + stepDz * stepDz <= 0.49D) {
                completed++;
                lastVerifiedProgressTick = tick;
                stepGoal = null;
                navigator.release(client);
                return;
            }
            boolean routed = navigator.drive(client, player, Vec3.atBottomCenterOf(stepGoal), 0.7D, false, tick);
            if (!routed && navigator.consecutivePlanFailures() > 20) {
                finish(client, this, false, "cannot enter excavated step without a safe collision route; "
                    + navigator.diagnoseDirectStep(client, player, stepGoal));
            }
        }

        private void prepareNextStep(Minecraft client, LocalPlayer player) {
            BlockPos current = navigator.standingBlockPos(client, player);
            int dy = Integer.compare(targetY, current.getY());
            if (dy > 0) {
                Direction upwardDirection = chooseExcavationDirection(client, player, targetY);
                if (upwardDirection == null) upwardDirection = chooseScaffoldDirection(client, player);
                if (upwardDirection == null) {
                    finish(client, this, false, "no safe supported direction for next upward stair at " + current.toShortString());
                    return;
                }
                direction = upwardDirection;
            }
            stepGoal = current.relative(direction).offset(0, dy, 0);
            if (dy > 0) {
                BlockPos support = stepGoal.below();
                BlockState supportState = client.level.getBlockState(support);
                if (supportState.isAir()) {
                    scaffoldItem = selectScaffoldItem(player);
                    BlockPos placementTarget = canPlaceScaffold(client, support)
                        ? support
                        : canPlaceScaffold(client, support.below()) ? support.below() : null;
                    if (scaffoldItem == null || placementTarget == null) {
                        finish(client, this, false, "upward_stair_needs_safe_support_material at " + support.toShortString());
                        return;
                    }
                    scaffold = placementTarget.immutable();
                    scaffoldStarted = tick;
                    scaffoldLastAttempt = tick - 10L;
                    stepGoal = null;
                    return;
                }
                if (!supportState.getFluidState().isEmpty()
                    || supportState.getCollisionShape(client.level, support).isEmpty()) {
                    finish(client, this, false, "upward_stair_has_no_solid_support at " + support.toShortString());
                    return;
                }
                // Clear every ceiling cell touched by the real player AABB, not only the block
                // containing the feet. A player standing close to an X/Z boundary overlaps two
                // columns; clearing one column made the collision planner correctly reject the
                // jump forever even though the nominal tunnel cell looked open.
                var body = player.getBoundingBox();
                int minX = (int) Math.floor(body.minX + 1.0E-5D);
                int maxX = (int) Math.floor(body.maxX - 1.0E-5D);
                int minZ = (int) Math.floor(body.minZ + 1.0E-5D);
                int maxZ = (int) Math.floor(body.maxZ - 1.0E-5D);
                int ceilingY = current.getY() + 2;
                for (int x = minX; x <= maxX; x++) {
                    for (int z = minZ; z <= maxZ; z++) {
                        BlockPos departureCeiling = new BlockPos(x, ceilingY, z);
                        BlockState ceilingState = client.level.getBlockState(departureCeiling);
                        if (ceilingState.isAir()) continue;
                        if (!WildernessGuard.safeNaturalBreak(client, departureCeiling)
                            || ceilingState.getDestroySpeed(client.level, departureCeiling) < 0.0F
                            || dangerousFluidAdjacent(client, departureCeiling)) {
                            finish(client, this, false, "unsafe_upward_departure_ceiling=" + blockId(ceilingState)
                                + " at " + departureCeiling.toShortString());
                            return;
                        }
                        if (!breakQueue.contains(departureCeiling)) breakQueue.add(departureCeiling.immutable());
                    }
                }
            }
            int clearance = dy < 0 ? 2 : 1;
            for (int y = 0; y <= clearance; y++) {
                BlockPos position = stepGoal.above(y);
                BlockState state = client.level.getBlockState(position);
                if (state.isAir()) continue;
                if (!WildernessGuard.safeNaturalBreak(client, position)
                    || state.getDestroySpeed(client.level, position) < 0.0F) {
                    finish(client, this, false, "unsafe_or_artificial_tunnel_block=" + blockId(state) + " at " + position.toShortString());
                    return;
                }
                if (dangerousFluidAdjacent(client, position)) {
                    finish(client, this, false, "dangerous_fluid_detected_near_tunnel at " + position.toShortString());
                    return;
                }
                breakQueue.add(position.immutable());
            }
        }

        private void continueScaffold(Minecraft client, LocalPlayer player) {
            BlockState observed = client.level.getBlockState(scaffold);
            String observedId = blockId(observed);
            if (observedId.equals(scaffoldItem)) {
                OwnedBlockRegistry.registerPlacedStructure(client, scaffold, observedId);
                placedSupports++;
                lastVerifiedProgressTick = tick;
                scaffold = null;
                scaffoldItem = null;
                navigator.release(client);
                return;
            }
            if (!observed.isAir()) {
                finish(client, this, false, "scaffold target changed before confirmation: " + observedId);
                return;
            }
            if (!canPlaceScaffold(client, scaffold)) {
                finish(client, this, false, "scaffold site became unsafe at " + scaffold.toShortString());
                return;
            }
            if (!ensureHotbarItem(client, player, scaffoldItem)) {
                if (inventoryCount(player, scaffoldItem) <= 0) {
                    finish(client, this, false, "ran out of scaffold material " + scaffoldItem);
                }
                return;
            }
            if (tick - scaffoldLastAttempt >= 10L) {
                if (!placeHeldBlockAt(client, player, scaffold)) {
                    finish(client, this, false, "no legal support face for upward scaffold " + scaffold.toShortString());
                    return;
                }
                scaffoldLastAttempt = tick;
            }
            if (tick - scaffoldStarted > 80L) {
                finish(client, this, false, "server did not confirm upward scaffold placement");
            }
        }

        private void continueBreaking(Minecraft client, LocalPlayer player) {
            BlockState state = client.level.getBlockState(breaking);
            if (state.isAir()) {
                registerDropsNear(client, breaking);
                brokenBlocks++;
                lastVerifiedProgressTick = tick;
                breaking = null;
                client.gameMode.stopDestroyBlock();
                return;
            }
            if (!WildernessGuard.safeNaturalBreak(client, breaking) || dangerousFluidAdjacent(client, breaking)) {
                finish(client, this, false, "block changed or became unsafe during excavation");
                return;
            }
            if (player.distanceToSqr(Vec3.atCenterOf(breaking)) > 25.0D) {
                finish(client, this, false, "tunnel block moved outside legal reach");
                return;
            }
            if (!ToolSelector.ensureBestMiningTool(client, player, state)) return;
            lookAt(player, breaking.getX() + 0.5D, breaking.getY() + 0.5D, breaking.getZ() + 0.5D);
            if (tick == breakStarted) client.gameMode.startDestroyBlock(breaking, Direction.UP);
            else client.gameMode.continueDestroyBlock(breaking, Direction.UP);
            player.swing(InteractionHand.MAIN_HAND);
            if (tick - breakStarted > 240L) finish(client, this, false, "server did not confirm tunnel block break");
        }

        private String debugStatus() {
            LocalPlayer player = Minecraft.getInstance().player;
            String playerPosition = player == null ? "not_in_world" : player.blockPosition().toShortString();
            return "steps=" + completed
                + "; broken=" + brokenBlocks
                + "; supports=" + placedSupports
                + "; player=" + playerPosition
                + "; goal=" + (stepGoal == null ? "none" : stepGoal.toShortString())
                + "; breaking=" + (breaking == null ? "none" : breaking.toShortString())
                + "; scaffold=" + (scaffold == null ? "none" : scaffold.toShortString())
                + "; idle_ticks=" + (tick - lastVerifiedProgressTick);
        }
    }

    private final class ExploreTask extends Task {
        private final String purpose;
        private final double radius;
        private Vec3 goal;
        private int replans;
        private BlockPos obstacle;
        private long obstacleStarted;

        ExploreTask(String id, JsonObject action, LocalPlayer player) {
            super(id, "explore_frontier", EXPLORE_TIMEOUT_TICKS);
            purpose = string(action, "purpose", "resource");
            // One action is one bounded route segment. Long exploration is resumed by the
            // persistent planner, preventing the Node action timeout from cancelling real progress.
            radius = Math.min(48.0D, integer(action, "radius", 8, 256, 32));
            goal = frontierGoal(player, radius, frontierSequence++);
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            if (obstacle != null) {
                BlockState state = client.level.getBlockState(obstacle);
                if (state.isAir()) {
                    client.gameMode.stopDestroyBlock();
                    registerDropsNear(client, obstacle);
                    obstacle = null;
                    navigator.release(client);
                } else if (!WildernessGuard.safeNaturalBreak(client, obstacle)
                    || player.distanceToSqr(Vec3.atCenterOf(obstacle)) > 25.0D
                    || dangerousFluidAdjacent(client, obstacle)) {
                    finish(client, this, false, "frontier obstacle became unsafe");
                } else {
                    if (!ToolSelector.ensureBestMiningTool(client, player, state)) return;
                    lookAt(player, obstacle.getX() + 0.5D, obstacle.getY() + 0.5D, obstacle.getZ() + 0.5D);
                    client.gameMode.continueDestroyBlock(obstacle, Direction.UP);
                    player.swing(InteractionHand.MAIN_HAND);
                    if (tick - obstacleStarted > 240L) finish(client, this, false, "frontier obstacle break was not confirmed");
                }
                return;
            }
            if (player.distanceToSqr(goal) <= 9.0D) {
                WildernessGuard.Assessment assessment = WildernessGuard.assess(
                    client,
                    player.blockPosition(),
                    WildernessGuard.DEFAULT_SCAN_RADIUS,
                    minimumPlayerDistance,
                    System.getenv("MCAI_OWNER_NAME")
                );
                finish(client, this, true, "verified_discovery_route_segment_reached; purpose=" + purpose
                    + "; environment=" + (assessment.allowed() ? "natural_terrain_likely" : "protected_structure_nearby")
                    + (assessment.reasons().isEmpty() ? "" : "; evidence=" + String.join(",", assessment.reasons()))
                    + "; x=" + Math.floor(player.getX()) + "; z=" + Math.floor(player.getZ()));
                return;
            }
            boolean routed = navigator.drive(client, player, goal, 2.0D, true, tick);
            if (!routed && navigator.consecutivePlanFailures() >= 12) {
                BlockPos candidate = forwardObstacle(client, player, goal);
                if (candidate != null && WildernessGuard.safeNaturalBreak(client, candidate)
                    && player.distanceToSqr(Vec3.atCenterOf(candidate)) <= 25.0D
                    && !dangerousFluidAdjacent(client, candidate)) {
                    BlockState state = client.level.getBlockState(candidate);
                    if (!ToolSelector.ensureBestMiningTool(client, player, state)) return;
                    lookAt(player, candidate.getX() + 0.5D, candidate.getY() + 0.5D, candidate.getZ() + 0.5D);
                    obstacle = candidate.immutable();
                    obstacleStarted = tick;
                    client.gameMode.startDestroyBlock(obstacle, Direction.UP);
                    player.swing(InteractionHand.MAIN_HAND);
                    return;
                }
                if (++replans <= 3) {
                    goal = frontierGoal(player, Math.max(16.0D, radius * 0.75D), frontierSequence++);
                    navigator.release(client);
                } else finish(client, this, false, "no_safe_frontier_route_after_three_planned_bearings");
            }
        }
    }

    private final class PortalBuildTask extends Task {
        private final BlockPos base;
        private final Direction axis;
        private final List<BlockPos> frame;
        private int index;
        private long interactionTick;
        private boolean igniting;

        PortalBuildTask(String id, JsonObject action, Minecraft client) {
            super(id, "build_nether_portal", CONTAINER_TIMEOUT_TICKS * 3);
            if (!booleanValue(action, "verifiedWilderness", false) && primitives.approvedZone() == null) {
                throw new IllegalArgumentException("portal building requires verified wilderness or an approved zone");
            }
            PortalSite site = findPortalSite(client);
            if (site == null) throw new IllegalArgumentException("no loaded flat and clear portal site passed wilderness verification");
            base = site.base();
            axis = site.axis();
            frame = portalFrame(base, axis);
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            BlockPos existingPortal = findBlock(client, base, 8, state -> state.is(Blocks.NETHER_PORTAL));
            if (existingPortal != null) {
                finish(client, this, true, "verified_nether_portal_formed_at=" + existingPortal.toShortString());
                return;
            }
            if (player.distanceToSqr(Vec3.atCenterOf(base)) > 30.25D) {
                navigator.drive(client, player, Vec3.atCenterOf(base), 4.5D, true, tick);
                return;
            }
            navigator.release(client);
            if (index < frame.size()) {
                BlockPos target = frame.get(index);
                BlockState state = client.level.getBlockState(target);
                if (state.is(Blocks.OBSIDIAN)) { index++; interactionTick = 0L; return; }
                if (!state.isAir()) {
                    finish(client, this, false, "portal frame target is no longer empty: " + blockId(state));
                    return;
                }
                if (!ensureHotbarItem(client, player, "minecraft:obsidian")) {
                    if (inventoryCount(player, "minecraft:obsidian") <= 0) finish(client, this, false, "ran out of obsidian while building portal");
                    return;
                }
                if (tick - interactionTick >= 10L) {
                    if (!placeHeldBlockAt(client, player, target)) {
                        finish(client, this, false, "no legal support face for portal frame block " + target.toShortString());
                        return;
                    }
                    interactionTick = tick;
                }
                if (interactionTick > 0L && tick - interactionTick > 80L) finish(client, this, false, "server did not confirm obsidian placement");
                return;
            }
            igniting = true;
            if (!ensureHotbarItem(client, player, "minecraft:flint_and_steel")) {
                if (inventoryCount(player, "minecraft:flint_and_steel") <= 0) finish(client, this, false, "flint_and_steel missing before portal ignition");
                return;
            }
            BlockPos bottomInterior = base.relative(axis);
            if (tick - interactionTick >= 20L) {
                useBlock(client, player, bottomInterior);
                interactionTick = tick;
            }
            if (igniting && tick - interactionTick > 100L) finish(client, this, false, "server did not form a nether portal after ignition");
        }
    }

    private final class TravelTask extends Task {
        private final String targetDimension;
        private BlockPos portal;
        private String startDimension;
        private Vec3 searchGoal;
        private Vec3 throwOrigin;
        private Vec3 lastEyePosition;
        private EyeOfEnder eye;
        private boolean waitingForEye;
        private long eyeThrownTick;
        private int eyeThrows;
        private boolean strongholdLikely;
        private Direction digDirection;
        private BlockPos digGoal;
        private final ArrayDeque<BlockPos> digQueue = new ArrayDeque<>();
        private BlockPos breaking;
        private long breakStarted;
        private long lastFrameScan;
        private List<BlockPos> frames = List.of();

        TravelTask(String id, JsonObject action) {
            super(id, "travel_to_dimension", TRAVEL_TIMEOUT_TICKS);
            targetDimension = string(action, "dimension", "");
            if (!Set.of("minecraft:overworld", "minecraft:the_nether", "minecraft:the_end").contains(targetDimension)) {
                throw new IllegalArgumentException("invalid dimension " + targetDimension);
            }
        }

        @Override
        void tick(Minecraft client) {
            LocalPlayer player = client.player;
            String current = client.level.dimension().identifier().toString();
            if (startDimension == null) startDimension = current;
            if (current.equals(targetDimension)) {
                finish(client, this, true, "verified_dimension=" + current);
                return;
            }
            boolean endPortalTravel = targetDimension.equals("minecraft:the_end")
                || current.equals("minecraft:the_end") && targetDimension.equals("minecraft:overworld");
            portal = findBlock(client, player.blockPosition(), 36, state -> endPortalTravel
                ? state.is(Blocks.END_PORTAL)
                : state.is(Blocks.NETHER_PORTAL));
            if (portal != null) {
                navigator.drive(client, player, Vec3.atCenterOf(portal), 0.2D, false, tick);
                return;
            }
            if (current.equals("minecraft:the_end") && targetDimension.equals("minecraft:overworld")) {
                Vec3 centralExit = new Vec3(0.5D, player.getY(), 0.5D);
                double exitDx = player.getX() - centralExit.x;
                double exitDz = player.getZ() - centralExit.z;
                if (Math.sqrt(exitDx * exitDx + exitDz * exitDz) > 8.0D) {
                    navigator.drive(client, player, centralExit, 5.0D, true, tick);
                    return;
                }
                finish(client, this, false, "no_loaded_end_exit_portal_near_central_island");
                return;
            }
            if (!targetDimension.equals("minecraft:the_end")) {
                finish(client, this, false, "no_loaded_nether_portal; build or discover a safe portal first");
                return;
            }
            if (!current.equals("minecraft:overworld")) {
                finish(client, this, false, "stronghold search requires the overworld");
                return;
            }

            if (tick - lastFrameScan >= 40L || frames.isEmpty()) {
                frames = findBlocksVertical(client, player.blockPosition(), 40, state -> state.is(Blocks.END_PORTAL_FRAME), 24);
                lastFrameScan = tick;
            }
            if (!frames.isEmpty()) {
                BlockPos emptyFrame = frames.stream()
                    .filter(position -> !client.level.getBlockState(position).getValue(EndPortalFrameBlock.HAS_EYE))
                    .min(Comparator.comparingDouble(position -> player.distanceToSqr(Vec3.atCenterOf(position)))).orElse(null);
                if (emptyFrame != null) {
                    if (!ensureHotbarItem(client, player, "minecraft:ender_eye")) {
                        finish(client, this, false, "end portal frame needs more ender eyes");
                        return;
                    }
                    if (player.distanceToSqr(Vec3.atCenterOf(emptyFrame)) > 16.0D) {
                        navigator.drive(client, player, Vec3.atCenterOf(emptyFrame), 2.5D, true, tick);
                        return;
                    }
                    navigator.release(client);
                    useBlock(client, player, emptyFrame);
                    return;
                }
                // Every visible frame has an eye; allow the server one moment to form the portal.
                if (tick - lastFrameScan > 60L) finish(client, this, false, "all visible frames contain eyes but no end portal formed");
                return;
            }

            if (strongholdLikely) {
                tickStrongholdDig(client, player);
                return;
            }

            if (waitingForEye) {
                eye = client.level.getEntitiesOfClass(
                        EyeOfEnder.class, player.getBoundingBox().inflate(32.0D), entity -> entity.isAlive() && !entity.isRemoved()
                    ).stream().min(Comparator.<EyeOfEnder>comparingDouble(player::distanceToSqr)).orElse(null);
                if (eye != null) {
                    waitingForEye = false;
                    lastEyePosition = eye.position();
                } else if (tick - eyeThrownTick > 30L) {
                    finish(client, this, false, "server did not spawn a trackable eye of ender");
                }
                return;
            }
            if (eye != null) {
                if (eye.isAlive() && !eye.isRemoved() && tick - eyeThrownTick <= 120L) {
                    lastEyePosition = eye.position();
                    return;
                }
                Vec3 observed = lastEyePosition;
                eye = null;
                if (observed == null || throwOrigin == null) {
                    finish(client, this, false, "thrown ender eye was not observable");
                    return;
                }
                double dx = observed.x - throwOrigin.x;
                double dz = observed.z - throwOrigin.z;
                double horizontal = Math.sqrt(dx * dx + dz * dz);
                if (horizontal < 5.0D || observed.y < throwOrigin.y - 2.0D) {
                    strongholdLikely = true;
                    searchGoal = new Vec3(observed.x, player.getY(), observed.z);
                    digDirection = Direction.fromYRot(player.getYRot());
                } else {
                    double segment = Math.min(112.0D, Math.max(48.0D, horizontal * 8.0D));
                    searchGoal = new Vec3(
                        throwOrigin.x + dx / horizontal * segment,
                        player.getY(),
                        throwOrigin.z + dz / horizontal * segment
                    );
                }
            }
            if (searchGoal != null) {
                if (player.distanceToSqr(searchGoal) > 16.0D) {
                    navigator.drive(client, player, searchGoal, 3.0D, true, tick);
                    return;
                }
                navigator.release(client);
                searchGoal = null;
                if (strongholdLikely) return;
            }
            if (inventoryCount(player, "minecraft:ender_eye") <= 0) {
                finish(client, this, false, "no ender eye remains for stronghold triangulation");
                return;
            }
            if (!ensureHotbarItem(client, player, "minecraft:ender_eye")) return;
            throwOrigin = player.position();
            lastEyePosition = null;
            client.gameMode.useItem(player, InteractionHand.MAIN_HAND);
            player.swing(InteractionHand.MAIN_HAND);
            eyeThrownTick = tick;
            eyeThrows++;
            waitingForEye = true;
            if (eyeThrows > 32) finish(client, this, false, "stronghold search exceeded 32 eye throws");
        }

        private void tickStrongholdDig(Minecraft client, LocalPlayer player) {
            if (searchGoal != null && player.distanceToSqr(searchGoal) > 16.0D) {
                navigator.drive(client, player, searchGoal, 3.0D, true, tick);
                return;
            }
            searchGoal = null;
            if (breaking != null) {
                BlockState state = client.level.getBlockState(breaking);
                if (state.isAir()) {
                    client.gameMode.stopDestroyBlock();
                    registerDropsNear(client, breaking);
                    breaking = null;
                    return;
                }
                if (!WildernessGuard.safeNaturalBreak(client, breaking)) {
                    finish(client, this, false, "stronghold-like artificial blocks reached; refusing blind destruction at " + breaking.toShortString());
                    return;
                }
                if (dangerousFluidAdjacent(client, breaking)) {
                    finish(client, this, false, "dangerous fluid found while descending toward stronghold");
                    return;
                }
                if (!ToolSelector.ensureBestMiningTool(client, player, state)) return;
                lookAt(player, breaking.getX() + 0.5D, breaking.getY() + 0.5D, breaking.getZ() + 0.5D);
                client.gameMode.continueDestroyBlock(breaking, Direction.UP);
                player.swing(InteractionHand.MAIN_HAND);
                if (tick - breakStarted > 240L) finish(client, this, false, "stronghold descent block break was not confirmed");
                return;
            }
            if (!digQueue.isEmpty()) {
                BlockState nextState = client.level.getBlockState(digQueue.peekFirst());
                if (!ToolSelector.ensureBestMiningTool(client, player, nextState)) return;
                breaking = digQueue.removeFirst();
                breakStarted = tick;
                client.gameMode.startDestroyBlock(breaking, Direction.UP);
                return;
            }
            if (digGoal != null) {
                if (player.distanceToSqr(Vec3.atBottomCenterOf(digGoal)) <= 2.0D) digGoal = null;
                else {
                    navigator.drive(client, player, Vec3.atBottomCenterOf(digGoal), 0.7D, false, tick);
                    return;
                }
            }
            if (player.blockPosition().getY() <= client.level.getMinY() + 8) {
                finish(client, this, false, "reached world minimum without loading an end portal frame");
                return;
            }
            BlockPos current = player.blockPosition();
            digGoal = current.relative(digDirection).below();
            for (int y = 0; y <= 2; y++) {
                BlockPos position = digGoal.above(y);
                BlockState state = client.level.getBlockState(position);
                if (state.isAir()) continue;
                if (!WildernessGuard.safeNaturalBreak(client, position)) {
                    finish(client, this, false, "protected or stronghold block reached before portal room became observable: " + blockId(state));
                    return;
                }
                digQueue.add(position.immutable());
            }
        }
    }

    private LivingEntity findHuntTarget(Minecraft client, LocalPlayer player, String purpose) {
        List<LivingEntity> candidates = client.level.getEntitiesOfClass(
            LivingEntity.class,
            player.getBoundingBox().inflate(32.0D),
            entity -> entity != player && entity.isAlive() && !entity.isRemoved() && huntMatches(entity, purpose)
        );
        return candidates.stream()
            .filter(entity -> safeHuntTarget(client, entity, purpose))
            .min(Comparator.<LivingEntity>comparingDouble(player::distanceToSqr).thenComparingInt(Entity::getId))
            .orElse(null);
    }

    private boolean safeHuntTarget(Minecraft client, LivingEntity entity, String purpose) {
        if (entity.hasCustomName() || entity instanceof AgeableMob ageable && ageable.isBaby()
            || entity instanceof TamableAnimal tamable && tamable.isTame()
            || entity instanceof Leashable leashable && leashable.isLeashed()) return false;
        if (Set.of("ender_pearl", "blaze_rod").contains(purpose)) return entity instanceof Enemy;
        if (!WildernessGuard.safePlacementArea(client, entity.blockPosition(), 6)) return false;
        LocalPlayer bot = client.player;
        return client.level.players().stream().noneMatch(player -> player != bot && player.isAlive()
            && player.distanceToSqr(entity) < minimumPlayerDistance * minimumPlayerDistance);
    }

    private static boolean huntMatches(LivingEntity entity, String purpose) {
        String id = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
        return switch (purpose) {
            case "food" -> Set.of("minecraft:cow", "minecraft:pig", "minecraft:chicken", "minecraft:sheep",
                "minecraft:rabbit", "minecraft:cod", "minecraft:salmon", "minecraft:hoglin").contains(id);
            case "wool" -> id.equals("minecraft:sheep");
            case "leather" -> id.equals("minecraft:cow");
            case "ender_pearl" -> id.equals("minecraft:enderman");
            case "blaze_rod" -> id.equals("minecraft:blaze");
            default -> false;
        };
    }

    private static LivingEntity findHostile(Minecraft client, LocalPlayer player, int requestedId, String protectPlayer) {
        return client.level.getEntitiesOfClass(
                LivingEntity.class,
                player.getBoundingBox().inflate(32.0D),
                entity -> entity != player && entity instanceof Enemy && entity.isAlive() && !entity.isRemoved()
                    && (requestedId < 0 || entity.getId() == requestedId)
                    && (protectPlayer.isBlank() || entity instanceof Mob mob && mob.getTarget() instanceof AbstractClientPlayer target
                        && target.getGameProfile().name().equalsIgnoreCase(protectPlayer))
            ).stream()
            .min(Comparator.comparingDouble(player::distanceToSqr))
            .orElse(null);
    }

    private static int purposeInventoryCount(LocalPlayer player, String purpose) {
        if (player == null) return 0;
        int total = 0;
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (stack.isEmpty()) continue;
            String id = itemId(stack);
            boolean match = switch (purpose) {
                case "food" -> id.matches("minecraft:(?:beef|porkchop|chicken|mutton|rabbit|cod|salmon)");
                case "wool" -> id.endsWith("_wool");
                case "leather" -> id.equals("minecraft:leather");
                case "ender_pearl" -> id.equals("minecraft:ender_pearl");
                case "blaze_rod" -> id.equals("minecraft:blaze_rod");
                default -> false;
            };
            if (match) total += stack.getCount();
        }
        return total;
    }

    private static ItemEntity nearestPurposeDrop(Minecraft client, LocalPlayer player, String purpose, Vec3 origin) {
        return client.level.getEntitiesOfClass(
                ItemEntity.class,
                player.getBoundingBox().inflate(24.0D),
                entity -> entity.isAlive() && !entity.isRemoved() && purposeDropMatches(entity.getItem(), purpose)
                    && (origin == null || entity.position().distanceTo(origin) <= 6.0D)
            ).stream().min(Comparator.<ItemEntity>comparingDouble(player::distanceToSqr)).orElse(null);
    }

    private static boolean purposeDropMatches(ItemStack stack, String purpose) {
        String id = itemId(stack);
        return switch (purpose) {
            case "food" -> id.matches("minecraft:(?:beef|porkchop|chicken|mutton|rabbit|cod|salmon)");
            case "wool" -> id.endsWith("_wool");
            case "leather" -> id.equals("minecraft:leather");
            case "ender_pearl" -> id.equals("minecraft:ender_pearl");
            case "blaze_rod" -> id.equals("minecraft:blaze_rod");
            default -> false;
        };
    }

    private static String inferredSmeltOutput(String input) {
        return switch (input) {
            case "minecraft:raw_iron", "minecraft:iron_ore", "minecraft:deepslate_iron_ore" -> "minecraft:iron_ingot";
            case "minecraft:raw_gold", "minecraft:gold_ore", "minecraft:deepslate_gold_ore", "minecraft:nether_gold_ore" -> "minecraft:gold_ingot";
            case "minecraft:raw_copper", "minecraft:copper_ore", "minecraft:deepslate_copper_ore" -> "minecraft:copper_ingot";
            case "minecraft:beef" -> "minecraft:cooked_beef";
            case "minecraft:porkchop" -> "minecraft:cooked_porkchop";
            case "minecraft:chicken" -> "minecraft:cooked_chicken";
            case "minecraft:mutton" -> "minecraft:cooked_mutton";
            case "minecraft:rabbit" -> "minecraft:cooked_rabbit";
            case "minecraft:cod" -> "minecraft:cooked_cod";
            case "minecraft:salmon" -> "minecraft:cooked_salmon";
            case "minecraft:potato" -> "minecraft:baked_potato";
            default -> throw new IllegalArgumentException("no deterministic smelt output for " + input);
        };
    }

    private static int chooseOffer(MerchantMenu menu, LocalPlayer player, String desired) {
        int best = -1;
        double bestScore = Double.NEGATIVE_INFINITY;
        for (int index = 0; index < menu.getOffers().size(); index++) {
            MerchantOffer offer = menu.getOffers().get(index);
            if (offer.isOutOfStock() || !affordable(player, offer)) continue;
            String result = itemId(offer.getResult());
            if (desired != null && !result.equals(desired)) continue;
            double score = tradeResultScore(result);
            if (desired == null && score <= 0.0D) continue;
            if (score > bestScore) { best = index; bestScore = score; }
        }
        return best;
    }

    private static boolean affordable(LocalPlayer player, MerchantOffer offer) {
        ItemStack first = offer.getCostA();
        ItemStack second = offer.getCostB();
        return inventoryCount(player, itemId(first)) >= first.getCount()
            && (second.isEmpty() || inventoryCount(player, itemId(second)) >= second.getCount());
    }

    private static double tradeResultScore(String id) {
        if (id.equals("minecraft:emerald")) return 10.0D;
        if (id.equals("minecraft:enchanted_book")) return 9.0D;
        if (id.contains("diamond_") || id.contains("iron_")) return 8.0D;
        if (id.matches("minecraft:(?:bread|golden_carrot|cooked_.*|ender_pearl|arrow)")) return 5.0D;
        return 0.0D;
    }

    private static AbstractVillager nearestVillager(Minecraft client, LocalPlayer player) {
        return client.level.getEntitiesOfClass(
                AbstractVillager.class, player.getBoundingBox().inflate(24.0D),
                villager -> villager.isAlive() && !villager.isBaby() && !villager.isTrading()
            ).stream().min(Comparator.<AbstractVillager>comparingDouble(player::distanceToSqr)).orElse(null);
    }

    private static String chooseEnchantableItem(LocalPlayer player, String requested) {
        return player.getInventory().getNonEquipmentItems().stream()
            .filter(stack -> !stack.isEmpty() && stack.isDamageableItem() && stack.getEnchantments().isEmpty())
            .map(AdvancedTaskController::itemId)
            .filter(id -> requested == null || id.equals(requested))
            .sorted(Comparator.comparingInt(AdvancedTaskController::equipmentScore).reversed())
            .findFirst().orElse(null);
    }

    private static int equipmentScore(String id) {
        int material = id.contains("netherite_") ? 50 : id.contains("diamond_") ? 40 : id.contains("iron_") ? 30 : id.contains("golden_") ? 20 : 10;
        int kind = id.endsWith("_sword") ? 5 : id.endsWith("_pickaxe") ? 4 : id.endsWith("_axe") ? 3 : 1;
        return material + kind;
    }

    private interface BlockPredicate { boolean test(BlockState state); }

    private record PortalSite(BlockPos base, Direction axis) { }

    private PortalSite findPortalSite(Minecraft client) {
        LocalPlayer player = client.player;
        BlockPos origin = player.blockPosition();
        for (int distance : List.of(8, 10, 12, 14, 6)) {
            for (Direction forward : List.of(Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST)) {
                Direction axis = forward.getAxis() == Direction.Axis.Z ? Direction.EAST : Direction.SOUTH;
                BlockPos center = origin.relative(forward, distance);
                BlockPos base = center.relative(axis, -1);
                List<BlockPos> frame = portalFrame(base, axis);
                PrimitiveTaskController.ApprovedZone zone = primitives.approvedZone();
                if (zone != null && frame.stream().anyMatch(position -> !zone.contains(position))) continue;
                boolean clear = true;
                for (BlockPos position : frame) {
                    if (!client.level.isLoaded(position) || !client.level.getBlockState(position).isAir()) { clear = false; break; }
                }
                if (!clear) continue;
                for (int offset = 0; offset < 4; offset++) {
                    BlockPos bottom = base.relative(axis, offset);
                    if (client.level.getBlockState(bottom.below()).getCollisionShape(client.level, bottom.below()).isEmpty()) {
                        clear = false;
                        break;
                    }
                }
                if (!clear) continue;
                WildernessGuard.Assessment assessment = WildernessGuard.assess(
                    client, center, 8, minimumPlayerDistance, null
                );
                if (assessment.allowed()) return new PortalSite(base.immutable(), axis);
            }
        }
        return null;
    }

    private static List<BlockPos> portalFrame(BlockPos base, Direction axis) {
        List<BlockPos> output = new ArrayList<>(14);
        for (int x = 0; x < 4; x++) output.add(base.relative(axis, x));
        for (int y = 1; y <= 3; y++) {
            output.add(base.above(y));
            output.add(base.relative(axis, 3).above(y));
        }
        output.add(base.above(4));
        output.add(base.relative(axis, 3).above(4));
        output.add(base.relative(axis).above(4));
        output.add(base.relative(axis, 2).above(4));
        return output;
    }

    private static BlockPos findBlock(Minecraft client, BlockPos center, int radius, BlockPredicate predicate) {
        BlockPos best = null;
        double bestDistance = Double.POSITIVE_INFINITY;
        for (BlockPos cursor : BlockPos.betweenClosed(center.offset(-radius, -8, -radius), center.offset(radius, 8, radius))) {
            if (!client.level.isLoaded(cursor) || !predicate.test(client.level.getBlockState(cursor))) continue;
            double distance = cursor.distSqr(center);
            if (distance < bestDistance) { best = cursor.immutable(); bestDistance = distance; }
        }
        return best;
    }

    private static BlockPos findOwnedBlock(Minecraft client, BlockPos center, int radius, BlockPredicate predicate) {
        BlockPos best = null;
        double bestDistance = Double.POSITIVE_INFINITY;
        for (BlockPos cursor : BlockPos.betweenClosed(center.offset(-radius, -8, -radius), center.offset(radius, 8, radius))) {
            if (!client.level.isLoaded(cursor)) continue;
            BlockState state = client.level.getBlockState(cursor);
            String id = blockId(state);
            if (!predicate.test(state) || !OwnedBlockRegistry.isOwned(client, cursor, id)) continue;
            double distance = cursor.distSqr(center);
            if (distance < bestDistance) { best = cursor.immutable(); bestDistance = distance; }
        }
        return best;
    }

    private static List<BlockPos> findBlocksVertical(Minecraft client, BlockPos center, int radius, BlockPredicate predicate, int limit) {
        List<BlockPos> output = new ArrayList<>();
        int minimumY = client.level.getMinY();
        int maximumY = client.level.getMaxY() - 1;
        for (int x = center.getX() - radius; x <= center.getX() + radius; x++) {
            for (int z = center.getZ() - radius; z <= center.getZ() + radius; z++) {
                BlockPos column = new BlockPos(x, center.getY(), z);
                if (!client.level.isLoaded(column)) continue;
                for (int y = minimumY; y <= maximumY; y++) {
                    BlockPos position = new BlockPos(x, y, z);
                    if (predicate.test(client.level.getBlockState(position))) {
                        output.add(position);
                        if (output.size() >= limit) return output;
                    }
                }
            }
        }
        return output;
    }

    private static boolean ensureHotbarItem(Minecraft client, LocalPlayer player, String targetItemId) {
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (!stack.isEmpty() && itemId(stack).equals(targetItemId)) {
                if (player.getInventory().getSelectedSlot() != slot) {
                    player.getInventory().setSelectedSlot(slot);
                    player.connection.send(new ServerboundSetCarriedItemPacket(slot));
                }
                return true;
            }
        }
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        int source = -1;
        for (int slot = Inventory.getSelectionSize(); slot < items.size(); slot++) {
            if (!items.get(slot).isEmpty() && itemId(items.get(slot)).equals(targetItemId)) { source = slot; break; }
        }
        if (source < 0) return false;
        int destination = player.getInventory().getSelectedSlot();
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            if (player.getInventory().getItem(slot).isEmpty()) { destination = slot; break; }
        }
        client.gameMode.handleContainerInput(player.inventoryMenu.containerId, source, destination, ContainerInput.SWAP, player);
        return false;
    }

    private static void useBlock(Minecraft client, LocalPlayer player, BlockPos position) {
        Vec3 hit = Vec3.atCenterOf(position);
        lookAt(player, hit.x, hit.y, hit.z);
        client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, position, false));
        player.swing(InteractionHand.MAIN_HAND);
    }

    private static boolean placeHeldBlockAt(Minecraft client, LocalPlayer player, BlockPos target) {
        for (Direction face : List.of(Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST, Direction.DOWN)) {
            BlockPos support = target.relative(face.getOpposite());
            if (!client.level.isLoaded(support)) continue;
            BlockState supportState = client.level.getBlockState(support);
            if (supportState.isAir() || supportState.getCollisionShape(client.level, support).isEmpty()) continue;
            Vec3 hit = Vec3.atCenterOf(support).add(
                face.getStepX() * 0.5D,
                face.getStepY() * 0.5D,
                face.getStepZ() * 0.5D
            );
            lookAt(player, hit.x, hit.y, hit.z);
            client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, new BlockHitResult(hit, face, support, false));
            player.swing(InteractionHand.MAIN_HAND);
            return true;
        }
        return false;
    }

    private static int findPlayerMenuSlot(AbstractContainerMenu menu, String targetItemId) {
        for (int index = 0; index < menu.slots.size(); index++) {
            Slot slot = menu.getSlot(index);
            ItemStack stack = slot.getItem();
            if (!stack.isEmpty() && itemId(stack).equals(targetItemId) && index >= containerSlotCount(menu)) return index;
        }
        return -1;
    }

    private static int findFuelMenuSlot(AbstractContainerMenu menu) {
        for (int index = containerSlotCount(menu); index < menu.slots.size(); index++) {
            ItemStack stack = menu.getSlot(index).getItem();
            if (!stack.isEmpty() && isFuel(itemId(stack))) return index;
        }
        return -1;
    }

    private static int containerSlotCount(AbstractContainerMenu menu) {
        if (menu instanceof AbstractFurnaceMenu) return 3;
        if (menu instanceof MerchantMenu) return 3;
        if (menu instanceof EnchantmentMenu) return 2;
        return 0;
    }

    private static boolean isFuel(String id) {
        return id.equals("minecraft:coal") || id.equals("minecraft:charcoal") || id.equals("minecraft:blaze_rod")
            || id.endsWith("_log") || id.endsWith("_wood") || id.endsWith("_planks")
            || id.equals("minecraft:stick") || id.equals("minecraft:dried_kelp_block");
    }

    private static void quickMove(Minecraft client, LocalPlayer player, AbstractContainerMenu menu, int slot) {
        client.gameMode.handleContainerInput(menu.containerId, slot, 0, ContainerInput.QUICK_MOVE, player);
    }

    private static boolean dangerousFluidAdjacent(Minecraft client, BlockPos position) {
        for (Direction direction : Direction.values()) {
            BlockState state = client.level.getBlockState(position.relative(direction));
            if (!state.getFluidState().isEmpty()) return true;
        }
        return false;
    }

    private void registerDropsNear(Minecraft client, BlockPos position) {
        for (ItemEntity entity : client.level.getEntitiesOfClass(
            ItemEntity.class,
            new net.minecraft.world.phys.AABB(position).inflate(3.0D),
            item -> item.isAlive() && !item.isRemoved() && !item.getItem().isEmpty()
        )) primitives.registerOwnedDrop(entity);
    }

    private static BlockPos forwardObstacle(Minecraft client, LocalPlayer player, Vec3 goal) {
        double dx = goal.x - player.getX();
        double dz = goal.z - player.getZ();
        Direction direction = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? Direction.EAST : Direction.WEST) : (dz > 0 ? Direction.SOUTH : Direction.NORTH);
        BlockPos feet = player.blockPosition().relative(direction);
        if (!client.level.getBlockState(feet).isAir()) return feet;
        BlockPos head = feet.above();
        return client.level.getBlockState(head).isAir() ? null : head;
    }

    private static Vec3 frontierGoal(LocalPlayer player, double radius, int sequence) {
        double goldenAngle = Math.PI * (3.0D - Math.sqrt(5.0D));
        double angle = sequence * goldenAngle;
        double distance = Math.max(12.0D, Math.min(radius, 24.0D + (sequence % 4) * 12.0D));
        return new Vec3(player.getX() + Math.cos(angle) * distance, player.getY(), player.getZ() + Math.sin(angle) * distance);
    }

    private static Direction chooseExcavationDirection(Minecraft client, LocalPlayer player, int targetY) {
        Direction preferred = Direction.fromYRot(player.getYRot());
        Direction best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        for (Direction direction : List.of(Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST)) {
            BlockPos cursor = player.blockPosition();
            double score = direction == preferred ? 0.0D : direction == preferred.getOpposite() ? 1.5D : 0.75D;
            boolean unsafe = false;
            // Upward routes may need to turn around gravel pockets or the previously excavated
            // corridor. Validate the next supported stair here and reselect again after every
            // successful step instead of rejecting a usable exit because step two differs.
            int lookAhead = targetY > player.blockPosition().getY() ? 1 : 6;
            for (int step = 0; step < lookAhead; step++) {
                int dy = Integer.compare(targetY, cursor.getY());
                cursor = cursor.relative(direction).offset(0, dy, 0);
                if (dy > 0) {
                    BlockPos support = cursor.below();
                    BlockState supportState = client.level.getBlockState(support);
                    if (supportState.isAir() || !supportState.getFluidState().isEmpty()
                        || supportState.getCollisionShape(client.level, support).isEmpty()) {
                        unsafe = true;
                        break;
                    }
                }
                int clearance = dy < 0 ? 2 : 1;
                for (int y = 0; y <= clearance; y++) {
                    BlockPos position = cursor.above(y);
                    BlockState state = client.level.getBlockState(position);
                    if (state.isAir()) continue;
                    if (!WildernessGuard.safeNaturalBreak(client, position) || dangerousFluidAdjacent(client, position)) {
                        unsafe = true;
                        break;
                    }
                    score += 1.0D + Math.max(0.0D, state.getDestroySpeed(client.level, position)) * 0.05D;
                }
                if (unsafe) break;
            }
            if (!unsafe && score < bestScore) {
                best = direction;
                bestScore = score;
            }
        }
        return best;
    }

    private static Direction chooseScaffoldDirection(Minecraft client, LocalPlayer player) {
        if (selectScaffoldItem(player) == null) return null;
        Direction preferred = Direction.fromYRot(player.getYRot());
        return List.of(preferred, preferred.getClockWise(), preferred.getCounterClockWise(), preferred.getOpposite()).stream()
            .filter(direction -> {
                BlockPos support = player.blockPosition().relative(direction);
                return canPlaceScaffold(client, support) || canPlaceScaffold(client, support.below());
            })
            .findFirst().orElse(null);
    }

    private static boolean canPlaceScaffold(Minecraft client, BlockPos support) {
        if (client == null || client.level == null || !client.level.isLoaded(support)
            || !client.level.getBlockState(support).isAir()) return false;
        if (client.player != null && client.player.getBoundingBox()
            .intersects(new net.minecraft.world.phys.AABB(support))) return false;
        BlockPos below = support.below();
        BlockState belowState = client.level.getBlockState(below);
        if (belowState.isAir() || !belowState.getFluidState().isEmpty()
            || belowState.getCollisionShape(client.level, below).isEmpty()) return false;
        for (int y = 1; y <= 2; y++) {
            BlockPos clearance = support.above(y);
            BlockState state = client.level.getBlockState(clearance);
            if (!state.isAir() && (!WildernessGuard.safeNaturalBreak(client, clearance)
                || dangerousFluidAdjacent(client, clearance))) return false;
        }
        return true;
    }

    private static String selectScaffoldItem(LocalPlayer player) {
        for (String item : List.of("minecraft:cobblestone", "minecraft:cobbled_deepslate", "minecraft:dirt")) {
            if (inventoryCount(player, item) > 0) return item;
        }
        return null;
    }

    private static String excavationDirectionReport(Minecraft client, LocalPlayer player, int targetY) {
        List<String> reports = new ArrayList<>();
        BlockPos origin = player.blockPosition();
        int dy = Integer.compare(targetY, origin.getY());
        for (Direction direction : List.of(Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST)) {
            BlockPos goal = origin.relative(direction).offset(0, dy, 0);
            List<String> reasons = new ArrayList<>();
            if (dy > 0) {
                BlockPos support = goal.below();
                BlockState supportState = client.level.getBlockState(support);
                if (supportState.isAir()) reasons.add("support_air");
                if (!supportState.getFluidState().isEmpty()) reasons.add("support_fluid");
                if (supportState.getCollisionShape(client.level, support).isEmpty()) reasons.add("support_no_collision");
                if (reasons.isEmpty()) reasons.add("support=" + blockId(supportState));
            }
            int clearance = dy < 0 ? 2 : 1;
            for (int y = 0; y <= clearance; y++) {
                BlockPos position = goal.above(y);
                BlockState state = client.level.getBlockState(position);
                if (state.isAir()) continue;
                if (!WildernessGuard.safeNaturalBreak(client, position)) reasons.add("unsafe=" + blockId(state) + "@" + y);
                if (dangerousFluidAdjacent(client, position)) reasons.add("fluid_near=" + blockId(state) + "@" + y);
            }
            reports.add(direction.getName() + "[" + String.join(",", reasons) + "]");
        }
        return "origin=" + origin.toShortString() + "; targetY=" + targetY + "; " + String.join(";", reports);
    }

    private static int inventoryCount(LocalPlayer player, String targetItemId) {
        int total = 0;
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (!stack.isEmpty() && itemId(stack).equals(targetItemId)) total += stack.getCount();
        }
        return total;
    }

    private static int resourceInventoryCount(LocalPlayer player, String resource) {
        int total = 0;
        String normalized = resource == null ? "" : resource.toLowerCase(Locale.ROOT);
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (stack.isEmpty()) continue;
            String id = itemId(stack);
            boolean matches = switch (normalized) {
                case "stone" -> id.equals("minecraft:cobblestone") || id.equals("minecraft:cobbled_deepslate")
                    || id.equals("minecraft:stone") || id.equals("minecraft:deepslate");
                case "coal" -> id.equals("minecraft:coal");
                case "iron" -> id.equals("minecraft:raw_iron") || id.equals("minecraft:iron_ingot");
                case "gold" -> id.equals("minecraft:raw_gold") || id.equals("minecraft:gold_ingot")
                    || id.equals("minecraft:gold_nugget");
                case "diamond" -> id.equals("minecraft:diamond");
                case "lapis" -> id.equals("minecraft:lapis_lazuli");
                case "redstone" -> id.equals("minecraft:redstone");
                case "obsidian" -> id.equals("minecraft:obsidian");
                default -> id.equals(normalized.contains(":") ? normalized : "minecraft:" + normalized);
            };
            if (matches) total += stack.getCount();
        }
        return total;
    }

    private static String itemId(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    private static String blockId(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    private static String normalizeId(String value) {
        Identifier id = Identifier.tryParse(value == null ? "" : value.trim().toLowerCase(Locale.ROOT));
        if (id == null) throw new IllegalArgumentException("invalid identifier: " + value);
        return id.toString();
    }

    private static String optionalId(JsonObject action, String key) {
        if (!action.has(key) || !action.get(key).isJsonPrimitive()) return null;
        String value = action.get(key).getAsString().trim();
        return value.isEmpty() ? null : normalizeId(value);
    }

    private static String required(JsonObject action, String key) {
        String value = string(action, key, "");
        if (value.isBlank()) throw new IllegalArgumentException("missing " + key);
        return value;
    }

    private static String string(JsonObject action, String key, String fallback) {
        if (action == null || !action.has(key) || !action.get(key).isJsonPrimitive()) return fallback;
        String value = action.get(key).getAsString().trim();
        return value.isEmpty() ? fallback : value;
    }

    private static int integer(JsonObject action, String key, int minimum, int maximum, int fallback) {
        if (action == null || !action.has(key) || !action.get(key).isJsonPrimitive()) return fallback;
        try { return Math.max(minimum, Math.min(maximum, action.get(key).getAsInt())); }
        catch (RuntimeException ignored) { return fallback; }
    }

    private static boolean booleanValue(JsonObject action, String key, boolean fallback) {
        if (action == null || !action.has(key) || !action.get(key).isJsonPrimitive()) return fallback;
        try { return action.get(key).getAsBoolean(); }
        catch (RuntimeException ignored) { return fallback; }
    }

    private static void lookAt(LocalPlayer player, double x, double y, double z) {
        double dx = x - player.getX();
        double dy = y - player.getEyeY();
        double dz = z - player.getZ();
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        player.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
        player.setXRot((float) -Math.toDegrees(Math.atan2(dy, horizontal)));
    }

    private static boolean inWorld(Minecraft client) {
        return client != null && client.player != null && client.level != null && client.gameMode != null;
    }

    private static String safeMessage(Exception error) {
        return error.getMessage() == null ? "no detail" : error.getMessage().replace('\n', ' ').replace('\r', ' ');
    }

    private static void clearControls(Minecraft client) {
        if (client == null) return;
        client.options.keyUp.setDown(false);
        client.options.keyDown.setDown(false);
        client.options.keyLeft.setDown(false);
        client.options.keyRight.setDown(false);
        client.options.keyJump.setDown(false);
        client.options.keySprint.setDown(false);
        client.options.keyShift.setDown(false);
        client.options.keyUse.setDown(false);
        client.options.keyAttack.setDown(false);
    }

    private void finish(Minecraft client, Task task, boolean ok, String detail) {
        if (active != task) return;
        task.cleanup(client);
        active = null;
        results.add(new TaskResult(task.id, ok, detail == null ? "" : detail));
    }
}
