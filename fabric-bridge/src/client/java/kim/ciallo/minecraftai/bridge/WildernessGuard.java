package kim.ciallo.minecraftai.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** 仅在运行时使用的证据，用于判断某个移动中的工作区域不像玩家领地。 */
public final class WildernessGuard {
    public static final int DEFAULT_SCAN_RADIUS = 10;
    private static final TagKey<Block> COAL_ORES = blockTag("minecraft:coal_ores");
    private static final TagKey<Block> DIAMOND_ORES = blockTag("minecraft:diamond_ores");
    private static final TagKey<Block> LAPIS_ORES = blockTag("minecraft:lapis_ores");
    private static final TagKey<Block> REDSTONE_ORES = blockTag("minecraft:redstone_ores");
    private static final TagKey<Block> EMERALD_ORES = blockTag("minecraft:emerald_ores");

    public record Assessment(boolean allowed, List<String> reasons) {
        public Assessment {
            reasons = List.copyOf(reasons);
        }
    }

    private WildernessGuard() { }

    public static Assessment assess(
        Minecraft client,
        BlockPos center,
        int radius,
        double minimumPlayerDistance,
        String authorizedPlayer
    ) {
        List<String> reasons = new ArrayList<>();
        if (client == null || client.player == null || client.level == null) {
            return new Assessment(false, List.of("not_in_world"));
        }
        int scanRadius = Math.max(4, Math.min(16, radius));
        int blockEntities = 0;
        int artificial = 0;
        int unloaded = 0;
        for (BlockPos cursor : BlockPos.betweenClosed(
            center.offset(-scanRadius, -5, -scanRadius),
            center.offset(scanRadius, 5, scanRadius)
        )) {
            if (!client.level.isLoaded(cursor)) {
                unloaded++;
                continue;
            }
            BlockState state = client.level.getBlockState(cursor);
            String id = blockId(state);
            boolean botOwned = OwnedBlockRegistry.isOwned(client, cursor, id);
            if (client.level.getBlockEntity(cursor) != null && !botOwned) blockEntities++;
            if (!state.isAir() && looksPlayerBuilt(id) && !botOwned) artificial++;
        }
        if (blockEntities > 0) reasons.add("block_entities_nearby=" + blockEntities);
        if (artificial >= 4) reasons.add("player_building_blocks_nearby=" + artificial);
        if (unloaded > (scanRadius * 2 + 1) * 16) reasons.add("insufficient_loaded_area");

        LocalPlayer player = client.player;
        for (AbstractClientPlayer other : client.level.players()) {
            if (other == player || !other.isAlive()) continue;
            if (authorizedPlayer != null && other.getGameProfile().name().equalsIgnoreCase(authorizedPlayer)) continue;
            if (other.distanceToSqr(center.getX() + 0.5D, center.getY() + 0.5D, center.getZ() + 0.5D)
                < minimumPlayerDistance * minimumPlayerDistance) {
                reasons.add("player_too_close=" + other.getGameProfile().name());
                break;
            }
        }
        return new Assessment(reasons.isEmpty(), reasons);
    }

    public static PrimitiveTaskController.ApprovedZone workZone(Minecraft client, BlockPos center, int radius, int verticalRadius) {
        int horizontal = Math.max(4, Math.min(32, radius));
        int vertical = Math.max(4, Math.min(64, verticalRadius));
        int minY = Math.max(client.level.getMinY(), center.getY() - vertical);
        int maxY = Math.min(client.level.getMaxY() - 1, center.getY() + vertical);
        return new PrimitiveTaskController.ApprovedZone(
            client.level.dimension().identifier().toString(),
            new BlockPos(center.getX() - horizontal, minY, center.getZ() - horizontal),
            new BlockPos(center.getX() + horizontal, maxY, center.getZ() + horizontal)
        );
    }

    /** 自主挖掘的逐方块规则；有意排除所有工作台/建筑类方块。 */
    public static boolean safeNaturalBreak(Minecraft client, BlockPos position) {
        if (client == null || client.level == null || !client.level.isLoaded(position)) return false;
        if (client.level.getBlockEntity(position) != null) return false;
        BlockState state = client.level.getBlockState(position);
        if (state.isAir() || !state.getFluidState().isEmpty()) return false;
        String id = blockId(state);
        if (looksPlayerBuilt(id)) return false;
        if (state.is(BlockTags.LOGS) || state.is(BlockTags.LEAVES)
            || state.is(BlockTags.BASE_STONE_OVERWORLD) || state.is(BlockTags.BASE_STONE_NETHER)
            || state.is(COAL_ORES) || state.is(BlockTags.IRON_ORES)
            || state.is(BlockTags.COPPER_ORES) || state.is(BlockTags.GOLD_ORES)
            || state.is(DIAMOND_ORES) || state.is(LAPIS_ORES)
            || state.is(REDSTONE_ORES) || state.is(EMERALD_ORES)) return true;
        String path = id.substring(id.indexOf(':') + 1).toLowerCase(Locale.ROOT);
        if (Set.of(
            "dirt", "grass_block", "coarse_dirt", "rooted_dirt", "podzol", "mud",
            "sand", "red_sand", "gravel", "clay", "snow", "snow_block", "ice",
            "netherrack", "basalt", "blackstone", "soul_sand", "soul_soil", "end_stone",
            "tuff", "calcite", "dripstone_block"
        ).contains(path)) return true;
        if (path.endsWith("_ore")) return true;
        if (path.equals("obsidian") && naturalObsidianEvidence(client, position)) return true;
        // 自然可采集的植物/作物：甘蔗、竹子、仙人掌、西瓜、南瓜、海带、菌类、藤蔓等。
        return state.is(BlockTags.CROPS) || Set.of(
            "sugar_cane", "cactus", "bamboo", "bamboo_sapling", "kelp", "kelp_plant",
            "sea_pickle", "seagrass", "tall_seagrass", "melon", "pumpkin", "carved_pumpkin",
            "sweet_berry_bush", "nether_wart", "cocoa", "brown_mushroom", "red_mushroom",
            "brown_mushroom_block", "red_mushroom_block", "mushroom_stem", "chorus_plant",
            "chorus_flower", "vine", "cave_vines", "cave_vines_plant", "weeping_vines",
            "weeping_vines_plant", "twisting_vines", "twisting_vines_plant", "glow_lichen"
        ).contains(path);
    }

    /** 候选级放置守卫；与 assess() 不同，它不会拒绝在结构附近进行的无害挖掘。 */
    public static boolean safePlacementArea(Minecraft client, BlockPos center, int radius) {
        if (client == null || client.level == null || !client.level.isLoaded(center)) return false;
        int scan = Math.max(2, Math.min(8, radius));
        for (BlockPos cursor : BlockPos.betweenClosed(center.offset(-scan, -3, -scan), center.offset(scan, 4, scan))) {
            if (!client.level.isLoaded(cursor)) return false;
            String id = blockId(client.level.getBlockState(cursor));
            if (OwnedBlockRegistry.isOwned(client, cursor, id)) continue;
            if (client.level.getBlockEntity(cursor) != null || looksPlayerBuilt(id)) return false;
        }
        return true;
    }

    private static boolean naturalObsidianEvidence(Minecraft client, BlockPos position) {
        for (Direction direction : Direction.values()) {
            BlockPos neighbor = position.relative(direction);
            if (!client.level.isLoaded(neighbor)) continue;
            String neighborId = blockId(client.level.getBlockState(neighbor));
            if (neighborId.equals("minecraft:water") || neighborId.equals("minecraft:lava")) return true;
        }
        return false;
    }

    public static boolean looksPlayerBuilt(String id) {
        String path = id.substring(id.indexOf(':') + 1).toLowerCase(Locale.ROOT);
        return path.contains("planks") || path.contains("bricks") || path.contains("door")
            || path.contains("trapdoor") || path.contains("fence") || path.contains("wall")
            || path.contains("stairs") || path.contains("slab") || path.contains("glass")
            || path.contains("concrete") || path.contains("terracotta") || path.contains("wool")
            || path.contains("carpet") || path.contains("bed") || path.contains("chest")
            || path.contains("barrel") || path.contains("furnace") || path.contains("crafting_table")
            || path.contains("redstone") || path.contains("rail") || path.contains("torch")
            || path.contains("lantern") || path.contains("ladder") || path.contains("bookshelf")
            || path.contains("sign") || path.contains("banner") || path.contains("anvil")
            || path.contains("enchanting_table") || path.contains("beacon") || path.contains("hopper");
    }

    private static String blockId(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    private static TagKey<Block> blockTag(String id) {
        return TagKey.create(Registries.BLOCK, Identifier.parse(id));
    }
}
