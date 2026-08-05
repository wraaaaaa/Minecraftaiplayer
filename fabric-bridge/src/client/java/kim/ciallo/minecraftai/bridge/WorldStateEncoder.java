package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.TagKey;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/** Produces the protocol-v2 structured state consumed by the controller. */
public final class WorldStateEncoder {
    public static final int SCHEMA_VERSION = 2;
    public static final double ENTITY_SCAN_RADIUS = 24.0D;
    public static final int BLOCK_SURVEY_RADIUS = 8;
    public static final int BLOCK_SURVEY_VERTICAL_RADIUS = 5;
    private static final long BLOCK_SURVEY_CACHE_MS = 5_000L;
    private static final TagKey<net.minecraft.world.level.block.Block> COAL_ORES = TagKey.create(
        Registries.BLOCK,
        Identifier.parse("minecraft:coal_ores")
    );

    private final AtomicLong sequence = new AtomicLong();
    private JsonObject cachedBlockSurvey;
    private BlockPos cachedSurveyCenter;
    private String cachedSurveyDimension;
    private long cachedSurveyAt;

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
        root.add("blockSurvey", blockSurvey(client, player));

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
        if (stack.getItem() instanceof BlockItem blockItem) {
            output.addProperty("placeableBlockId", BuiltInRegistries.BLOCK.getKey(blockItem.getBlock()).toString());
        }
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

    private JsonObject blockSurvey(Minecraft client, LocalPlayer player) {
        BlockPos center = player.blockPosition();
        String dimension = client.level.dimension().identifier().toString();
        long now = System.currentTimeMillis();
        if (cachedBlockSurvey != null
            && cachedSurveyCenter != null
            && dimension.equals(cachedSurveyDimension)
            && center.distSqr(cachedSurveyCenter) <= 16.0D
            && now - cachedSurveyAt < BLOCK_SURVEY_CACHE_MS) {
            return cachedBlockSurvey.deepCopy();
        }

        Map<String, SurveyBlock> resources = new HashMap<>();
        Map<String, SurveyBlock> artificial = new HashMap<>();
        Map<String, SurveyBlock> other = new HashMap<>();
        int sampled = 0;
        int solid = 0;
        int blockEntities = 0;
        for (BlockPos cursor : BlockPos.betweenClosed(
            center.offset(-BLOCK_SURVEY_RADIUS, -BLOCK_SURVEY_VERTICAL_RADIUS, -BLOCK_SURVEY_RADIUS),
            center.offset(BLOCK_SURVEY_RADIUS, BLOCK_SURVEY_VERTICAL_RADIUS, BLOCK_SURVEY_RADIUS)
        )) {
            if (!client.level.isLoaded(cursor)) continue;
            sampled++;
            BlockState state = client.level.getBlockState(cursor);
            if (state.isAir()) continue;
            solid++;
            String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
            boolean hasBlockEntity = client.level.getBlockEntity(cursor) != null;
            if (hasBlockEntity) blockEntities++;
            String category = naturalResourceCategory(state, id);
            Map<String, SurveyBlock> destination = category != null
                ? resources
                : hasBlockEntity || looksPlayerBuilt(id)
                    ? artificial
                    : other;
            destination.computeIfAbsent(id, ignored -> new SurveyBlock(id, category == null ? "other" : category))
                .observe(cursor, player.distanceToSqr(Vec3.atCenterOf(cursor)));
        }

        JsonObject survey = new JsonObject();
        survey.addProperty("radius", BLOCK_SURVEY_RADIUS);
        survey.addProperty("verticalRadius", BLOCK_SURVEY_VERTICAL_RADIUS);
        survey.addProperty("sampledBlocks", sampled);
        survey.addProperty("solidBlocks", solid);
        survey.addProperty("blockEntityCount", blockEntities);
        survey.add("center", position(center));
        survey.add("resources", surveyEntries(resources, 32));
        survey.add("artificial", surveyEntries(artificial, 24));
        survey.add("other", surveyEntries(other, 24));

        int artificialCount = artificial.values().stream().mapToInt(entry -> entry.count).sum();
        boolean protectedLikely = blockEntities > 0 || artificialCount >= 4;
        String classification = protectedLikely
            ? "protected_structure_nearby"
            : resources.isEmpty()
                ? "uncertain"
                : "natural_terrain_likely";
        survey.addProperty("classification", classification);
        survey.addProperty("protectedLikely", protectedLikely);
        JsonArray reasons = new JsonArray();
        if (blockEntities > 0) reasons.add("block_entities_detected");
        if (artificialCount >= 4) reasons.add("multiple_building_blocks_detected");
        if (!protectedLikely && !resources.isEmpty()) reasons.add("natural_resource_blocks_detected");
        if (resources.isEmpty() && artificial.isEmpty()) reasons.add("insufficient_distinctive_blocks");
        survey.add("reasons", reasons);

        cachedBlockSurvey = survey;
        cachedSurveyCenter = center.immutable();
        cachedSurveyDimension = dimension;
        cachedSurveyAt = now;
        return survey.deepCopy();
    }

    private static JsonArray surveyEntries(Map<String, SurveyBlock> entries, int limit) {
        JsonArray output = new JsonArray();
        entries.values().stream()
            .sorted(Comparator.comparingInt((SurveyBlock entry) -> entry.count).reversed()
                .thenComparingDouble(entry -> entry.nearestDistanceSqr)
                .thenComparing(entry -> entry.id))
            .limit(limit)
            .forEach(entry -> output.add(entry.toJson()));
        return output;
    }

    private static String naturalResourceCategory(BlockState state, String id) {
        if (state.is(BlockTags.LOGS)) return "logs";
        if (state.is(BlockTags.LEAVES)) return "leaves";
        if (state.is(COAL_ORES)) return "coal_ore";
        if (state.is(BlockTags.IRON_ORES)) return "iron_ore";
        if (state.is(BlockTags.COPPER_ORES)) return "copper_ore";
        if (state.is(BlockTags.GOLD_ORES)) return "gold_ore";
        if (state.is(BlockTags.BASE_STONE_OVERWORLD)) return "stone";
        String path = id.substring(id.indexOf(':') + 1).toLowerCase(Locale.ROOT);
        if (Set.of("dirt", "grass_block", "coarse_dirt", "rooted_dirt", "podzol", "mud").contains(path)) return "soil";
        if (Set.of("sand", "red_sand", "gravel", "clay", "snow", "snow_block", "ice").contains(path)) return "surface";
        return null;
    }

    private static boolean looksPlayerBuilt(String id) {
        String path = id.substring(id.indexOf(':') + 1).toLowerCase(Locale.ROOT);
        return path.contains("planks")
            || path.contains("bricks")
            || path.contains("door")
            || path.contains("trapdoor")
            || path.contains("fence")
            || path.contains("stairs")
            || path.contains("slab")
            || path.contains("glass")
            || path.contains("concrete")
            || path.contains("terracotta")
            || path.contains("wool")
            || path.contains("carpet")
            || path.contains("bed")
            || path.contains("chest")
            || path.contains("barrel")
            || path.contains("furnace")
            || path.contains("crafting_table")
            || path.contains("redstone")
            || path.contains("rail")
            || path.contains("torch")
            || path.contains("lantern")
            || path.contains("ladder")
            || path.contains("bookshelf");
    }

    private static JsonObject position(BlockPos position) {
        JsonObject output = new JsonObject();
        output.addProperty("x", position.getX());
        output.addProperty("y", position.getY());
        output.addProperty("z", position.getZ());
        return output;
    }

    private static final class SurveyBlock {
        private final String id;
        private final String category;
        private int count;
        private double nearestDistanceSqr = Double.POSITIVE_INFINITY;
        private BlockPos nearest;

        private SurveyBlock(String id, String category) {
            this.id = id;
            this.category = category;
        }

        private void observe(BlockPos position, double distanceSqr) {
            count++;
            if (distanceSqr < nearestDistanceSqr) {
                nearestDistanceSqr = distanceSqr;
                nearest = position.immutable();
            }
        }

        private JsonObject toJson() {
            JsonObject output = new JsonObject();
            output.addProperty("blockId", id);
            output.addProperty("category", category);
            output.addProperty("count", count);
            output.addProperty("nearestDistance", Math.sqrt(nearestDistanceSqr));
            if (nearest != null) output.add("nearest", position(nearest));
            return output;
        }
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
