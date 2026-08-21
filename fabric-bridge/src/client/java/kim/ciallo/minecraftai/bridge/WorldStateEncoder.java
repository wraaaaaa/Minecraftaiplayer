package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.TagKey;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.AgeableMob;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Leashable;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.component.Consumable;
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

/** 生成供控制器消费的 protocol-v2 结构化状态。 */
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
    private static final TagKey<net.minecraft.world.level.block.Block> DIAMOND_ORES = blockTag("minecraft:diamond_ores");
    private static final TagKey<net.minecraft.world.level.block.Block> LAPIS_ORES = blockTag("minecraft:lapis_ores");
    private static final TagKey<net.minecraft.world.level.block.Block> REDSTONE_ORES = blockTag("minecraft:redstone_ores");
    private static final TagKey<net.minecraft.world.level.block.Block> EMERALD_ORES = blockTag("minecraft:emerald_ores");

    private final AtomicLong sequence = new AtomicLong();
    private final String ownerName;
    private JsonObject cachedBlockSurvey;
    private BlockPos cachedSurveyCenter;
    private String cachedSurveyDimension;
    private long cachedSurveyAt;

    public WorldStateEncoder() {
        this("wraaaaaa");
    }

    public WorldStateEncoder(String ownerName) {
        this.ownerName = ownerName == null || ownerName.isBlank() ? "wraaaaaa" : ownerName.trim();
    }

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
        root.addProperty("experienceLevel", player.experienceLevel);
        root.addProperty("experienceProgress", player.experienceProgress);
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
        root.addProperty("freeSlots", InventoryCleanup.freeSlots(player));
        root.add("inventory", inventory(player));
        root.add("equipment", equipment(player));
        JsonObject ownerWaypoint = ownerWaypoint(client, player);
        if (ownerWaypoint != null) root.add("ownerWaypoint", ownerWaypoint);

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
        root.add("nearbyBlocks", nearbyBlocks(client, player));

        Integer currentThreatId = survival == null ? null : survival.snapshot().threatEntityId();
        root.add("hostiles", hostiles(client, player, currentThreatId));
        root.add("creatures", creatures(client, player));
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

    private JsonObject ownerWaypoint(Minecraft client, LocalPlayer player) {
        OwnerLocator.Fix fix = OwnerLocator.locate(client, player, ownerName);
        if (fix == null) return null;
        JsonObject output = new JsonObject();
        output.addProperty("name", fix.name());
        output.addProperty("uuid", fix.uuid().toString());
        output.addProperty("bearingDegrees", fix.bearingDegrees());
        output.addProperty("precision", fix.precision());
        if (Double.isFinite(fix.distance())) output.addProperty("distance", fix.distance());
        return output;
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
            String itemId = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
            int countInInventory = inventoryCountOf(player, itemId);
            encoded.addProperty("discardReason", InventoryCleanup.discardReason(stack, countInInventory));
            encoded.addProperty("valuable", InventoryCleanup.isValuable(stack));
            output.add(encoded);
        }
        return output;
    }

    private static int inventoryCountOf(LocalPlayer player, String itemId) {
        int total = 0;
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (!stack.isEmpty() && BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(itemId)) {
                total += stack.getCount();
            }
        }
        return total;
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
        String itemId = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
        output.addProperty("itemId", itemId);
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
        FoodProperties food = stack.get(DataComponents.FOOD);
        Consumable consumable = stack.get(DataComponents.CONSUMABLE);
        if (food != null && consumable != null) {
            output.addProperty("foodNutrition", food.nutrition());
            output.addProperty("foodSaturation", food.saturation());
            output.addProperty("safeFood", !isKnownUnsafeFood(itemId));
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

    private static boolean isKnownUnsafeFood(String itemId) {
        return Set.of(
            "minecraft:rotten_flesh", "minecraft:spider_eye", "minecraft:poisonous_potato",
            "minecraft:pufferfish", "minecraft:chicken", "minecraft:suspicious_stew",
            "minecraft:chorus_fruit"
        ).contains(itemId);
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
            LivingEntity target = entity instanceof Mob mob ? mob.getTarget() : null;
            boolean targetingPlayer = target == player;
            hostile.addProperty("targetingPlayer", targetingPlayer);
            if (target instanceof Player targetPlayer) hostile.addProperty("targetPlayerName", targetPlayer.getGameProfile().name());
            hostile.addProperty("currentThreat", currentThreatId != null && currentThreatId == entity.getId());
            hostile.add("position", position(entity));
            output.add(hostile);
        }
        return output;
    }

    private static JsonArray creatures(Minecraft client, LocalPlayer player) {
        List<LivingEntity> entities = client.level.getEntitiesOfClass(
            LivingEntity.class,
            player.getBoundingBox().inflate(ENTITY_SCAN_RADIUS),
            entity -> entity != player && entity instanceof Mob && !(entity instanceof Enemy)
                && entity.isAlive() && !entity.isRemoved()
        );
        entities.sort(Comparator.<LivingEntity>comparingDouble(player::distanceToSqr).thenComparingInt(Entity::getId));
        JsonArray output = new JsonArray();
        for (LivingEntity entity : entities) {
            JsonObject encoded = new JsonObject();
            encoded.addProperty("entityId", entity.getId());
            encoded.addProperty("uuid", entity.getUUID().toString());
            encoded.addProperty("typeId", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
            encoded.addProperty("distance", player.distanceTo(entity));
            encoded.addProperty("health", entity.getHealth());
            encoded.addProperty("baby", entity instanceof AgeableMob ageable && ageable.isBaby());
            encoded.addProperty("tamed", entity instanceof TamableAnimal tamable && tamable.isTame());
            encoded.addProperty("leashed", entity instanceof Leashable leashable && leashable.isLeashed());
            encoded.addProperty("customNamed", entity.hasCustomName());
            encoded.addProperty("inWater", entity.isInWater());
            if (entity.hasCustomName()) encoded.addProperty("name", entity.getCustomName().getString());
            encoded.add("position", position(entity));
            output.add(encoded);
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
        Map<String, SurveyBlock> owned = new HashMap<>();
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
            boolean botOwned = OwnedBlockRegistry.isOwned(client, cursor, id);
            if (hasBlockEntity && !botOwned) blockEntities++;
            String category = naturalResourceCategory(state, id);
            Map<String, SurveyBlock> destination = botOwned
                ? owned
                : category != null
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
        survey.add("owned", surveyEntries(owned, 24));
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

    private static JsonArray nearbyBlocks(Minecraft client, LocalPlayer player) {
        BlockPos center = player.blockPosition();
        List<NearbyBlock> candidates = new ArrayList<>();
        for (BlockPos cursor : BlockPos.betweenClosed(center.offset(-6, -4, -6), center.offset(6, 4, 6))) {
            if (!client.level.isLoaded(cursor)) continue;
            BlockState state = client.level.getBlockState(cursor);
            if (state.isAir()) continue;
            double distanceSqr = player.distanceToSqr(Vec3.atCenterOf(cursor));
            boolean exposed = distanceSqr <= 12.25D;
            if (!exposed) {
                for (Direction direction : Direction.values()) {
                    BlockPos adjacent = cursor.relative(direction);
                    if (client.level.isLoaded(adjacent)
                        && (client.level.getBlockState(adjacent).isAir() || !client.level.getFluidState(adjacent).isEmpty())) {
                        exposed = true;
                        break;
                    }
                }
            }
            if (!exposed) continue;
            String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
            String resource = naturalResourceCategory(state, id);
            String interactable = interactableKind(id);
            boolean blockEntity = client.level.getBlockEntity(cursor) != null;
            boolean owned = OwnedBlockRegistry.isOwned(client, cursor, id);
            String classification = owned ? "bot_owned" : resource != null ? "natural_resource" : blockEntity || looksPlayerBuilt(id) ? "protected_likely" : "unclassified";
            candidates.add(new NearbyBlock(cursor.immutable(), id, resource, interactable, classification, blockEntity,
                state.canBeReplaced(), !state.getFluidState().isEmpty(), state.getDestroySpeed(client.level, cursor), distanceSqr));
        }
        JsonArray output = new JsonArray();
        candidates.stream()
            .sorted(Comparator
                .comparingInt((NearbyBlock block) -> block.interactable() != null ? 0 : "natural_resource".equals(block.classification()) ? 1 : "protected_likely".equals(block.classification()) ? 3 : 2)
                .thenComparingDouble(NearbyBlock::distanceSqr))
            .limit(256)
            .forEach(block -> output.add(block.toJson()));
        return output;
    }

    private static String naturalResourceCategory(BlockState state, String id) {
        if (state.is(BlockTags.LOGS)) return "logs";
        if (state.is(BlockTags.LEAVES)) return "leaves";
        if (state.is(COAL_ORES)) return "coal_ore";
        if (state.is(BlockTags.IRON_ORES)) return "iron_ore";
        if (state.is(BlockTags.COPPER_ORES)) return "copper_ore";
        if (state.is(BlockTags.GOLD_ORES)) return "gold_ore";
        if (state.is(DIAMOND_ORES)) return "diamond_ore";
        if (state.is(LAPIS_ORES)) return "lapis_ore";
        if (state.is(REDSTONE_ORES)) return "redstone_ore";
        if (state.is(EMERALD_ORES)) return "emerald_ore";
        if (id.equals("minecraft:obsidian") || id.equals("minecraft:crying_obsidian")) return "obsidian";
        if (id.equals("minecraft:sugar_cane")) return "sugar_cane";
        if (id.endsWith("_portal") || id.equals("minecraft:end_portal_frame")) return "portal";
        if (state.is(BlockTags.BASE_STONE_OVERWORLD)) return "stone";
        String path = id.substring(id.indexOf(':') + 1).toLowerCase(Locale.ROOT);
        if (Set.of("dirt", "grass_block", "coarse_dirt", "rooted_dirt", "podzol", "mud").contains(path)) return "soil";
        if (Set.of("sand", "red_sand", "gravel", "clay", "snow", "snow_block", "ice").contains(path)) return "surface";
        // 其余非玩家建造的原版方块（植物、作物、菌类、藤蔓、珊瑚等）也识别为可采集资源，
        // 不再依赖“天然方块白名单”逐条比对。
        return looksPlayerBuilt(id) ? null : path;
    }

    private static String interactableKind(String id) {
        String path = id.substring(id.indexOf(':') + 1).toLowerCase(Locale.ROOT);
        if (path.endsWith("_button")) return "button";
        if (path.equals("lever")) return "lever";
        if (path.endsWith("_pressure_plate")) return "pressure_plate";
        if (path.endsWith("_trapdoor")) return "trapdoor";
        if (path.equals("tripwire")) return "tripwire";
        if (path.endsWith("_door")) return "door";
        if (path.endsWith("_fence_gate")) return "gate";
        if (path.endsWith("_portal") || path.equals("end_portal")) return "portal";
        return null;
    }

    private static TagKey<net.minecraft.world.level.block.Block> blockTag(String id) {
        return TagKey.create(Registries.BLOCK, Identifier.parse(id));
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

    private record NearbyBlock(
        BlockPos position,
        String blockId,
        String resourceCategory,
        String interactable,
        String classification,
        boolean blockEntity,
        boolean replaceable,
        boolean fluid,
        float destroySpeed,
        double distanceSqr
    ) {
        private JsonObject toJson() {
            JsonObject output = WorldStateEncoder.position(position);
            output.addProperty("blockId", blockId);
            if (resourceCategory != null) output.addProperty("resourceCategory", resourceCategory);
            if (interactable != null) output.addProperty("interactable", interactable);
            output.addProperty("classification", classification);
            output.addProperty("blockEntity", blockEntity);
            output.addProperty("replaceable", replaceable);
            output.addProperty("fluid", fluid);
            output.addProperty("destroySpeed", destroySpeed);
            output.addProperty("distance", Math.sqrt(distanceSqr));
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
