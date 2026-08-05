package kim.ciallo.minecraftai.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.EnderMan;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.monster.piglin.AbstractPiglin;
import net.minecraft.world.entity.monster.zombie.ZombifiedPiglin;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.Consumable;
import net.minecraft.world.item.component.ItemAttributeModifiers;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.level.LightLayer;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Deterministic, client-side emergency survival actions.
 *
 * <p>This controller intentionally does not navigate. It only consumes safe food that is already in
 * the hotbar and retaliates against a recently observed, non-neutral hostile that is already within
 * legal attack range. All inventory and combat mutations go through the normal multiplayer APIs.</p>
 */
public final class SurvivalController {
    public static final float DEFAULT_EAT_HEALTH_THRESHOLD = 10.0F;
    public static final int DEFAULT_EAT_FOOD_THRESHOLD = 14;
    public static final double DEFAULT_THREAT_SCAN_RADIUS = 12.0D;
    public static final long DEFAULT_THREAT_MEMORY_MS = 10_000L;
    public static final double IMMEDIATE_THREAT_DISTANCE = 3.25D;

    public enum Mode {
        IDLE,
        EATING,
        COMBAT,
        UNSAFE,
        DISCONNECTED
    }

    public record SafetyAssessment(boolean safeToIdle, List<String> reasons) {
        public SafetyAssessment {
            reasons = List.copyOf(reasons);
        }
    }

    public record Snapshot(
        Mode mode,
        boolean safeToIdle,
        List<String> safetyReasons,
        Integer threatEntityId,
        String detail
    ) {
        public Snapshot {
            safetyReasons = List.copyOf(safetyReasons);
        }
    }

    private final float eatHealthThreshold;
    private final int eatFoodThreshold;
    private final double threatScanRadius;
    private final long threatMemoryMs;
    private final String protectedPlayerName;
    private final boolean protectPlayer;
    private String escortPlayerName = "";
    private final Map<Integer, Long> recentThreats = new HashMap<>();

    private long localTick;
    private int eatingSlot = -1;
    private long eatingStartedTick;
    private int eatingInitialCount;
    private Item eatingInitialItem;
    private long completedFoodConsumptions;
    private long successfulAttacks;
    private Snapshot snapshot = new Snapshot(
        Mode.DISCONNECTED,
        false,
        List.of("not_in_world"),
        null,
        "not_in_world"
    );

    public SurvivalController() {
        this(
            DEFAULT_EAT_HEALTH_THRESHOLD,
            DEFAULT_EAT_FOOD_THRESHOLD,
            DEFAULT_THREAT_SCAN_RADIUS,
            DEFAULT_THREAT_MEMORY_MS
        );
    }

    public SurvivalController(float eatHealthThreshold, int eatFoodThreshold, double threatScanRadius, long threatMemoryMs) {
        this(eatHealthThreshold, eatFoodThreshold, threatScanRadius, threatMemoryMs, "", false);
    }

    public SurvivalController(float eatHealthThreshold, int eatFoodThreshold, double threatScanRadius, long threatMemoryMs, String protectedPlayerName, boolean protectPlayer) {
        this.eatHealthThreshold = Math.max(1.0F, Math.min(19.0F, eatHealthThreshold));
        this.eatFoodThreshold = Math.max(1, Math.min(20, eatFoodThreshold));
        this.threatScanRadius = Math.max(3.0D, Math.min(32.0D, threatScanRadius));
        this.threatMemoryMs = Math.max(1_000L, Math.min(60_000L, threatMemoryMs));
        this.protectedPlayerName = protectedPlayerName == null ? "" : protectedPlayerName.trim();
        this.protectPlayer = protectPlayer && !this.protectedPlayerName.isBlank();
    }

    /** Records the responsible entity from a client damage event. */
    public void noteThreat(DamageSource source) {
        if (source == null) return;
        Entity responsible = source.getEntity();
        if (responsible == null) responsible = source.getDirectEntity();
        noteThreat(responsible);
    }

    /** Records a hostile as an active threat for a short, bounded self-defense window. */
    public void noteThreat(Entity attacker) {
        if (attacker == null || !(attacker instanceof Enemy) || excludedFromAutomaticCombat(attacker)) return;
        recentThreats.put(attacker.getId(), System.currentTimeMillis() + threatMemoryMs);
    }

    /** Runs one deterministic survival tick on the Minecraft client thread. */
    public void tick(Minecraft client) {
        localTick++;
        LocalPlayer player = client == null ? null : client.player;
        if (client == null || player == null || client.level == null || client.gameMode == null) {
            releaseControls(client);
            eatingSlot = -1;
            eatingInitialItem = null;
            snapshot = new Snapshot(Mode.DISCONNECTED, false, List.of("not_in_world"), null, "not_in_world");
            return;
        }

        client.options.keyAttack.setDown(false);
        if (!player.isAlive() || player.getHealth() <= 0.0F) {
            cancelEating(client, player);
            snapshot = new Snapshot(Mode.UNSAFE, false, List.of("dead_or_dying"), null, "dead_or_dying");
            return;
        }

        long now = System.currentTimeMillis();
        recentThreats.entrySet().removeIf(entry -> entry.getValue() < now);
        LivingEntity threat = findCurrentThreat(client, player, now);
        double threatDistance = threat == null ? Double.POSITIVE_INFINITY : player.distanceTo(threat);

        if (player.isUnderWater() && player.getAirSupply() < player.getMaxAirSupply() * 3 / 4) {
            cancelEating(client, player);
            client.options.keyUp.setDown(false);
            client.options.keyDown.setDown(false);
            client.options.keyLeft.setDown(false);
            client.options.keyRight.setDown(false);
            client.options.keyJump.setDown(true);
            snapshot = new Snapshot(Mode.UNSAFE, false, List.of("low_air_underwater"), null, "surfacing_for_air");
            return;
        }
        client.options.keyJump.setDown(false);

        if (eatingSlot >= 0) {
            if (threat != null && threatDistance <= IMMEDIATE_THREAT_DISTANCE) {
                cancelEating(client, player);
            } else if (continueEating(client, player)) {
                publish(Mode.EATING, threat, "consuming_safe_food");
                return;
            }
        }

        boolean needsFood = player.getHealth() <= eatHealthThreshold
            || player.getFoodData().getFoodLevel() < eatFoodThreshold;

        if (needsFood && (threat == null || threatDistance > IMMEDIATE_THREAT_DISTANCE)) {
            FoodChoice food = chooseSafeHotbarFood(player);
            if (food != null && startEating(client, player, food)) {
                publish(Mode.EATING, threat, "started_safe_food");
                return;
            }
            if (food == null && moveSafeFoodToHotbar(client, player)) {
                snapshot = new Snapshot(Mode.UNSAFE, false, List.of("preparing_safe_food"), null, "moving_safe_food_to_hotbar");
                return;
            }
        }

        if (threat != null) {
            boolean attacked = attackThreat(client, player, threat);
            String detail = attacked
                ? "attack_sent"
                : player.isWithinAttackRange(player.getInventory().getSelectedItem(), threat.getBoundingBox(), 0.0D)
                    ? "waiting_for_legal_attack_or_line_of_sight"
                    : "threat_out_of_attack_range";
            publish(Mode.COMBAT, threat, detail);
            return;
        }

        if (needsFood) {
            List<String> reasons = new ArrayList<>(assessSafety(client).reasons());
            reasons.add(hasSafeFoodOutsideHotbar(player) ? "safe_food_outside_hotbar" : "no_safe_food_available");
            snapshot = new Snapshot(Mode.UNSAFE, false, distinct(reasons), null, "unable_to_eat");
            return;
        }

        client.options.keyUse.setDown(false);
        publish(Mode.IDLE, null, "idle");
    }

    /** Cancels survival-owned inputs and forgets short-lived combat state. */
    public void reset(Minecraft client) {
        LocalPlayer player = client == null ? null : client.player;
        if (player != null) cancelEating(client, player);
        else releaseControls(client);
        recentThreats.clear();
        eatingSlot = -1;
        snapshot = new Snapshot(Mode.DISCONNECTED, false, List.of("reset"), null, "reset");
    }

    public Snapshot snapshot() {
        return snapshot;
    }

    public Mode mode() {
        return snapshot.mode();
    }

    public boolean safeToIdle() {
        return snapshot.safeToIdle();
    }

    /** Dynamically protects the player currently being followed, in addition to the owner. */
    public void setEscortPlayerName(String playerName) {
        escortPlayerName = playerName == null ? "" : playerName.trim();
    }

    public long completedFoodConsumptionCount() {
        return completedFoodConsumptions;
    }

    public long successfulAttackCount() {
        return successfulAttacks;
    }

    public List<String> safetyReasons() {
        return snapshot.safetyReasons();
    }

    /** Releases every key this controller may own. */
    public static void releaseControls(Minecraft client) {
        if (client == null) return;
        client.options.keyUse.setDown(false);
        client.options.keyAttack.setDown(false);
        client.options.keyJump.setDown(false);
    }

    /** Neutral/high-risk hostiles are deliberately never selected for automatic retaliation. */
    public static boolean excludedFromAutomaticCombat(Entity entity) {
        return entity instanceof Creeper
            || entity instanceof EnderMan
            || entity instanceof AbstractPiglin
            || entity instanceof ZombifiedPiglin;
    }

    /** Computes whether remaining still is currently a safe action. */
    public static SafetyAssessment assessSafety(Minecraft client) {
        LocalPlayer player = client == null ? null : client.player;
        if (client == null || player == null || client.level == null) {
            return new SafetyAssessment(false, List.of("not_in_world"));
        }

        List<String> reasons = new ArrayList<>();
        if (!player.isAlive() || player.getHealth() <= 0.0F) reasons.add("dead_or_dying");
        if (player.getHealth() < 12.0F) reasons.add("low_health");
        if (player.getFoodData().getFoodLevel() < 8) reasons.add("low_food");
        if (player.isOnFire()) reasons.add("on_fire");
        if (player.isInLava()) reasons.add("in_lava");
        if (player.isUnderWater() && player.getAirSupply() < player.getMaxAirSupply() / 2) reasons.add("low_air_underwater");
        if (player.fallDistance > 3.0F) reasons.add("falling");

        BlockPos position = player.blockPosition();
        BlockPos below = position.below();
        if (!client.level.isLoaded(position) || !client.level.isLoaded(below)) {
            reasons.add("area_not_loaded");
        } else if (!client.level.loadedAndEntityCanStandOn(below, player) && !player.onGround()) {
            reasons.add("unstable_footing");
        }

        long clock = client.level.getOverworldClockTime();
        int timeOfDay = (int) Math.floorMod(clock, 24_000L);
        boolean skyDimension = client.level.dimensionType().hasSkyLight();
        boolean night = skyDimension && timeOfDay >= 12_542 && timeOfDay <= 23_460;
        boolean canSeeSky = client.level.canSeeSky(position.above());
        int blockLight = client.level.getBrightness(LightLayer.BLOCK, position);
        int spawnLightLimit = client.level.dimensionType().monsterSpawnBlockLightLimit();
        if (night && canSeeSky) reasons.add("exposed_at_night");
        if ((night || !canSeeSky) && blockLight <= spawnLightLimit) reasons.add("spawnable_light_level");

        List<LivingEntity> nearbyHostiles = client.level.getEntitiesOfClass(
            LivingEntity.class,
            player.getBoundingBox().inflate(12.0D),
            entity -> entity != player && entity instanceof Enemy && entity.isAlive() && !entity.isRemoved()
        );
        if (!nearbyHostiles.isEmpty()) reasons.add("nearby_hostile");
        return new SafetyAssessment(reasons.isEmpty(), distinct(reasons));
    }

    private LivingEntity findCurrentThreat(Minecraft client, LocalPlayer player, long now) {
        return client.level.getEntitiesOfClass(
                LivingEntity.class,
                player.getBoundingBox().inflate(threatScanRadius),
                entity -> entity != player
                    && entity instanceof Enemy
                    && entity.isAlive()
                    && !entity.isRemoved()
                    && entity.isAttackable()
                    && !entity.isAlliedTo(player)
                    && !excludedFromAutomaticCombat(entity)
                    && isThreatening(player, entity, now)
            )
            .stream()
            .min(Comparator.comparingDouble(player::distanceToSqr))
            .orElse(null);
    }

    private boolean isThreatening(LocalPlayer player, LivingEntity entity, long now) {
        Long expiresAt = recentThreats.get(entity.getId());
        if (expiresAt != null && expiresAt >= now) return true;
        if (player.getLastHurtByMob() == entity) return true;
        if (!(entity instanceof Mob mob)) return false;
        if (mob.getTarget() == player) return true;
        if (!(mob.getTarget() instanceof Player target)) return false;
        String targetName = target.getGameProfile().name();
        return protectPlayer && targetName.equalsIgnoreCase(protectedPlayerName)
            || !escortPlayerName.isBlank() && targetName.equalsIgnoreCase(escortPlayerName);
    }

    private FoodChoice chooseSafeHotbarFood(LocalPlayer player) {
        Inventory inventory = player.getInventory();
        FoodChoice best = null;
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            FoodProperties food = safeFoodProperties(player, stack);
            if (food == null) continue;
            double score = food.nutrition() * 4.0D + food.saturation() * 2.0D + Math.min(stack.getCount(), 16) * 0.01D;
            if (best == null || score > best.score()) best = new FoodChoice(slot, score);
        }
        return best;
    }

    private boolean hasSafeFoodOutsideHotbar(LocalPlayer player) {
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        for (int slot = Inventory.getSelectionSize(); slot < items.size(); slot++) {
            if (safeFoodProperties(player, items.get(slot)) != null) return true;
        }
        return false;
    }

    private boolean moveSafeFoodToHotbar(Minecraft client, LocalPlayer player) {
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        FoodChoice best = null;
        for (int slot = Inventory.getSelectionSize(); slot < items.size(); slot++) {
            ItemStack stack = items.get(slot);
            FoodProperties food = safeFoodProperties(player, stack);
            if (food == null) continue;
            double score = food.nutrition() * 4.0D + food.saturation() * 2.0D;
            if (best == null || score > best.score()) best = new FoodChoice(slot, score);
        }
        if (best == null || client.gameMode == null) return false;
        int destination = player.getInventory().getSelectedSlot();
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            if (player.getInventory().getItem(slot).isEmpty()) {
                destination = slot;
                break;
            }
        }
        int menuSlot = best.slot() < Inventory.getSelectionSize() ? 36 + best.slot() : best.slot();
        client.gameMode.handleContainerInput(player.inventoryMenu.containerId, menuSlot, destination, ContainerInput.SWAP, player);
        return true;
    }

    private static FoodProperties safeFoodProperties(LocalPlayer player, ItemStack stack) {
        if (stack == null || stack.isEmpty()) return null;
        FoodProperties food = stack.get(DataComponents.FOOD);
        Consumable consumable = stack.get(DataComponents.CONSUMABLE);
        if (food == null || consumable == null || !consumable.canConsume(player, stack)) return null;
        String id = net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
        // Component-based mod foods are accepted unless they are one of the vanilla foods with a
        // known harmful/random side effect. This keeps Farmer's Delight and similar cooked meals
        // usable without trusting translated display names.
        if (List.of(
            "minecraft:rotten_flesh", "minecraft:spider_eye", "minecraft:poisonous_potato",
            "minecraft:pufferfish", "minecraft:chicken", "minecraft:suspicious_stew",
            "minecraft:chorus_fruit"
        ).contains(id)) return null;
        return food;
    }

    private boolean startEating(Minecraft client, LocalPlayer player, FoodChoice choice) {
        selectHotbar(player, choice.slot());
        ItemStack selected = player.getInventory().getSelectedItem();
        FoodProperties food = safeFoodProperties(player, selected);
        if (food == null) return false;

        InteractionResult result = client.gameMode.useItem(player, InteractionHand.MAIN_HAND);
        if (!result.consumesAction() && !player.isUsingItem()) {
            client.options.keyUse.setDown(false);
            return false;
        }
        eatingSlot = choice.slot();
        eatingStartedTick = localTick;
        eatingInitialCount = selected.getCount();
        eatingInitialItem = selected.getItem();
        client.options.keyUse.setDown(true);
        return true;
    }

    private boolean continueEating(Minecraft client, LocalPlayer player) {
        if (eatingSlot < 0 || player.getInventory().getSelectedSlot() != eatingSlot) {
            cancelEating(client, player);
            return false;
        }

        ItemStack selected = player.getInventory().getSelectedItem();
        // A held use key can immediately begin using the next item in the same stack. Observe the
        // server-synchronised stack mutation before isUsingItem(), otherwise a completed meal can
        // remain reported as "consuming_safe_food" until the explicit action times out.
        if (selected.isEmpty()
            || selected.getItem() != eatingInitialItem
            || selected.getCount() < eatingInitialCount) {
            completedFoodConsumptions++;
            cancelEating(client, player);
            return false;
        }

        if (selected.isEmpty() || safeFoodProperties(player, selected) == null) {
            cancelEating(client, player);
            return false;
        }

        if (player.isUsingItem() && player.getUsedItemHand() == InteractionHand.MAIN_HAND) {
            client.options.keyUse.setDown(true);
            return true;
        }

        if (localTick - eatingStartedTick <= 2L && selected.getCount() == eatingInitialCount) {
            client.options.keyUse.setDown(true);
            return true;
        }

        client.options.keyUse.setDown(false);
        eatingSlot = -1;
        eatingInitialItem = null;
        return false;
    }

    private void cancelEating(Minecraft client, LocalPlayer player) {
        if (client != null) client.options.keyUse.setDown(false);
        if (eatingSlot >= 0 && client != null && client.gameMode != null && player.isUsingItem()) {
            client.gameMode.releaseUsingItem(player);
        }
        eatingSlot = -1;
        eatingInitialItem = null;
    }

    private boolean attackThreat(Minecraft client, LocalPlayer player, LivingEntity threat) {
        cancelEating(client, player);
        int weaponSlot = chooseBestHotbarWeapon(player);
        if (weaponSlot >= 0) selectHotbar(player, weaponSlot);

        ItemStack weapon = player.getInventory().getSelectedItem();
        if (!player.canAttack(threat) || !player.hasLineOfSight(threat)) return false;
        if (!player.isWithinAttackRange(weapon, threat.getBoundingBox(), 0.0D)) return false;
        if (player.getAttackStrengthScale(0.5F) < 0.9F) return false;

        client.gameMode.attack(player, threat);
        player.swing(InteractionHand.MAIN_HAND);
        successfulAttacks++;
        return true;
    }

    private int chooseBestHotbarWeapon(LocalPlayer player) {
        Inventory inventory = player.getInventory();
        int bestSlot = inventory.getSelectedSlot();
        double bestScore = weaponScore(player, inventory.getItem(bestSlot));
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            double score = weaponScore(player, inventory.getItem(slot));
            if (score > bestScore) {
                bestScore = score;
                bestSlot = slot;
            }
        }
        return bestSlot;
    }

    private static double weaponScore(LocalPlayer player, ItemStack stack) {
        if (stack == null || stack.isEmpty()) return 0.0D;
        if (stack.isDamageableItem() && stack.getMaxDamage() - stack.getDamageValue() <= 3) return -1.0D;

        double baseDamage = player.getAttributeBaseValue(Attributes.ATTACK_DAMAGE);
        double baseSpeed = player.getAttributeBaseValue(Attributes.ATTACK_SPEED);
        ItemAttributeModifiers modifiers = stack.get(DataComponents.ATTRIBUTE_MODIFIERS);
        double damage = modifiers == null
            ? baseDamage
            : modifiers.compute(Attributes.ATTACK_DAMAGE, baseDamage, EquipmentSlot.MAINHAND);
        double speed = modifiers == null
            ? baseSpeed
            : modifiers.compute(Attributes.ATTACK_SPEED, baseSpeed, EquipmentSlot.MAINHAND);
        int enchantmentLevels = stack.getEnchantments().entrySet().stream().mapToInt(entry -> entry.getIntValue()).sum();
        double weaponBonus = stack.has(DataComponents.WEAPON) ? 2.0D : 0.0D;
        return damage * Math.max(0.25D, Math.min(speed, 8.0D)) + enchantmentLevels * 0.35D + weaponBonus;
    }

    private static void selectHotbar(LocalPlayer player, int slot) {
        if (!Inventory.isHotbarSlot(slot)) throw new IllegalArgumentException("slot is not in the hotbar: " + slot);
        if (player.getInventory().getSelectedSlot() == slot) return;
        player.getInventory().setSelectedSlot(slot);
        player.connection.send(new ServerboundSetCarriedItemPacket(slot));
    }

    private void publish(Mode mode, LivingEntity threat, String detail) {
        Minecraft client = Minecraft.getInstance();
        SafetyAssessment safety = assessSafety(client);
        snapshot = new Snapshot(
            mode,
            safety.safeToIdle() && mode == Mode.IDLE,
            safety.reasons(),
            threat == null ? null : threat.getId(),
            detail
        );
    }

    private static List<String> distinct(List<String> values) {
        return values.stream().distinct().toList();
    }

    private record FoodChoice(int slot, double score) { }
}
