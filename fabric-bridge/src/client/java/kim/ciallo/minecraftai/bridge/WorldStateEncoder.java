package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.level.LightLayer;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/** Produces the protocol-v2 structured state consumed by the controller. */
public final class WorldStateEncoder {
    public static final int SCHEMA_VERSION = 2;
    public static final double ENTITY_SCAN_RADIUS = 24.0D;

    private final AtomicLong sequence = new AtomicLong();

    public JsonObject encode(Minecraft client) {
        return encode(client, null);
    }

    public JsonObject encode(Minecraft client, SurvivalController survival) {
        JsonObject root = new JsonObject();
        root.addProperty("schemaVersion", SCHEMA_VERSION);
        root.addProperty("seq", sequence.incrementAndGet());
        root.addProperty("observedAt", System.currentTimeMillis());

        LocalPlayer player = client == null ? null : client.player;
        if (client == null || player == null || client.level == null) {
            root.addProperty("connected", false);
            root.add("inventory", new JsonArray());
            root.add("equipment", new JsonArray());
            root.add("hostiles", new JsonArray());
            root.add("drops", new JsonArray());
            root.addProperty("safeToIdle", false);
            root.add("safetyReasons", strings(List.of("not_in_world")));
            root.addProperty("survivalMode", survival == null ? "DISCONNECTED" : survival.mode().name());
            return root;
        }

        root.addProperty("connected", true);
        root.add("position", position(player));
        root.addProperty("health", player.getHealth());
        root.addProperty("maxHealth", player.getMaxHealth());
        root.addProperty("food", player.getFoodData().getFoodLevel());
        root.addProperty("saturation", player.getFoodData().getSaturationLevel());
        root.addProperty("dimension", client.level.dimension().identifier().toString());

        JsonObject physical = new JsonObject();
        physical.addProperty("air", player.getAirSupply());
        physical.addProperty("maxAir", player.getMaxAirSupply());
        physical.addProperty("onFire", player.isOnFire());
        physical.addProperty("inWater", player.isInWater());
        physical.addProperty("underWater", player.isUnderWater());
        physical.addProperty("inLava", player.isInLava());
        physical.addProperty("onGround", player.onGround());
        physical.addProperty("fallDistance", player.fallDistance);
        root.add("physical", physical);

        root.addProperty("selectedHotbarSlot", player.getInventory().getSelectedSlot());
        root.add("inventory", inventory(player));
        root.add("equipment", equipment(player));

        BlockPos blockPosition = player.blockPosition();
        long clock = client.level.getOverworldClockTime();
        int timeOfDay = (int) Math.floorMod(clock, 24_000L);
        boolean hasSkyLight = client.level.dimensionType().hasSkyLight();
        boolean night = hasSkyLight && timeOfDay >= 12_542 && timeOfDay <= 23_460;
        JsonObject environment = new JsonObject();
        environment.addProperty("overworldClock", clock);
        environment.addProperty("timeOfDay", timeOfDay);
        environment.addProperty("night", night);
        environment.addProperty("hasSkyLight", hasSkyLight);
        environment.addProperty("canSeeSky", client.level.canSeeSky(blockPosition.above()));
        environment.addProperty("blockLight", client.level.getBrightness(LightLayer.BLOCK, blockPosition));
        environment.addProperty("skyLight", client.level.getBrightness(LightLayer.SKY, blockPosition));
        environment.addProperty("rawLight", client.level.getMaxLocalRawBrightness(blockPosition));
        environment.addProperty("monsterSpawnBlockLightLimit", client.level.dimensionType().monsterSpawnBlockLightLimit());
        root.add("environment", environment);

        Integer currentThreatId = survival == null ? null : survival.snapshot().threatEntityId();
        root.add("hostiles", hostiles(client, player, currentThreatId));
        root.add("drops", drops(client, player));

        SurvivalController.SafetyAssessment assessed = SurvivalController.assessSafety(client);
        List<String> safetyReasons = new ArrayList<>(assessed.reasons());
        if (survival != null) safetyReasons.addAll(survival.safetyReasons());
        safetyReasons = safetyReasons.stream().distinct().toList();
        boolean safeToIdle = assessed.safeToIdle() && (survival == null || survival.safeToIdle());
        root.addProperty("safeToIdle", safeToIdle);
        root.add("safetyReasons", strings(safetyReasons));
        root.addProperty("survivalMode", survival == null ? "UNMANAGED" : survival.mode().name());
        if (survival != null) root.addProperty("survivalDetail", survival.snapshot().detail());
        return root;
    }

    public long currentSequence() {
        return sequence.get();
    }

    private static JsonArray inventory(LocalPlayer player) {
        JsonArray output = new JsonArray();
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        for (int slot = 0; slot < items.size(); slot++) {
            ItemStack stack = items.get(slot);
            if (stack.isEmpty()) continue;
            JsonObject encoded = item(stack);
            encoded.addProperty("slot", slot);
            encoded.addProperty("hotbar", Inventory.isHotbarSlot(slot));
            encoded.addProperty("selected", slot == player.getInventory().getSelectedSlot());
            output.add(encoded);
        }
        return output;
    }

    private static JsonArray equipment(LocalPlayer player) {
        JsonArray output = new JsonArray();
        for (EquipmentSlot slot : EquipmentSlot.values()) {
            ItemStack stack = player.getItemBySlot(slot);
            if (stack.isEmpty()) continue;
            JsonObject encoded = item(stack);
            encoded.addProperty("slot", slot.getSerializedName());
            output.add(encoded);
        }
        return output;
    }

    private static JsonObject item(ItemStack stack) {
        JsonObject output = new JsonObject();
        output.addProperty("itemId", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
        output.addProperty("name", stack.getHoverName().getString());
        output.addProperty("count", stack.getCount());
        if (stack.isDamageableItem()) {
            JsonObject durability = new JsonObject();
            int maximum = stack.getMaxDamage();
            int remaining = Math.max(0, maximum - stack.getDamageValue());
            durability.addProperty("damage", stack.getDamageValue());
            durability.addProperty("max", maximum);
            durability.addProperty("remaining", remaining);
            durability.addProperty("fraction", maximum == 0 ? 0.0D : (double) remaining / maximum);
            output.add("durability", durability);
        }

        JsonArray enchantments = new JsonArray();
        stack.getEnchantments().entrySet().stream()
            .sorted(Comparator.comparing(entry -> enchantmentId(entry.getKey())))
            .forEach(entry -> {
                JsonObject enchantment = new JsonObject();
                enchantment.addProperty("id", enchantmentId(entry.getKey()));
                enchantment.addProperty("level", entry.getIntValue());
                enchantments.add(enchantment);
            });
        output.add("enchantments", enchantments);
        return output;
    }

    private static String enchantmentId(Holder<Enchantment> enchantment) {
        return enchantment.unwrapKey()
            .map(key -> key.identifier().toString())
            .orElse("minecraft:unregistered");
    }

    private static JsonArray hostiles(Minecraft client, LocalPlayer player, Integer currentThreatId) {
        List<LivingEntity> entities = client.level.getEntitiesOfClass(
            LivingEntity.class,
            player.getBoundingBox().inflate(ENTITY_SCAN_RADIUS),
            entity -> entity != player && entity instanceof Enemy && entity.isAlive() && !entity.isRemoved()
        );
        entities.sort(Comparator.<LivingEntity>comparingDouble(player::distanceToSqr).thenComparingInt(Entity::getId));

        JsonArray output = new JsonArray();
        for (LivingEntity entity : entities) {
            JsonObject hostile = new JsonObject();
            hostile.addProperty("entityId", entity.getId());
            hostile.addProperty("uuid", entity.getUUID().toString());
            hostile.addProperty("typeId", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
            hostile.addProperty("distance", player.distanceTo(entity));
            hostile.addProperty("health", entity.getHealth());
            hostile.addProperty("maxHealth", entity.getMaxHealth());
            hostile.addProperty("lineOfSight", player.hasLineOfSight(entity));
            hostile.addProperty("autoCombatExcluded", SurvivalController.excludedFromAutomaticCombat(entity));
            boolean targetingPlayer = entity instanceof Mob mob && mob.getTarget() == player;
            hostile.addProperty("targetingPlayer", targetingPlayer);
            hostile.addProperty("currentThreat", currentThreatId != null && currentThreatId == entity.getId());
            hostile.add("position", position(entity));
            output.add(hostile);
        }
        return output;
    }

    private static JsonArray drops(Minecraft client, LocalPlayer player) {
        List<ItemEntity> entities = client.level.getEntitiesOfClass(
            ItemEntity.class,
            player.getBoundingBox().inflate(ENTITY_SCAN_RADIUS),
            entity -> entity.isAlive() && !entity.isRemoved() && !entity.getItem().isEmpty()
        );
        entities.sort(Comparator.<ItemEntity>comparingDouble(player::distanceToSqr).thenComparingInt(Entity::getId));

        JsonArray output = new JsonArray();
        for (ItemEntity entity : entities) {
            JsonObject drop = item(entity.getItem());
            drop.addProperty("entityId", entity.getId());
            drop.addProperty("uuid", entity.getUUID().toString());
            drop.addProperty("distance", player.distanceTo(entity));
            drop.addProperty("age", entity.getAge());
            drop.addProperty("pickupDelayed", entity.hasPickUpDelay());
            drop.add("position", position(entity));
            output.add(drop);
        }
        return output;
    }

    private static JsonObject position(Entity entity) {
        JsonObject position = new JsonObject();
        position.addProperty("x", entity.getX());
        position.addProperty("y", entity.getY());
        position.addProperty("z", entity.getZ());
        return position;
    }

    private static JsonArray strings(List<String> values) {
        JsonArray output = new JsonArray();
        for (String value : values) output.add(value);
        return output;
    }
}
