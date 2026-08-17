package kim.ciallo.minecraftai.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.state.BlockState;

import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 本 Bot 放置并经服务器确认的方块的持久化凭证。 */
public final class OwnedBlockRegistry {
    private record OwnedBlock(String dimension, BlockPos position, String blockId) { }

    private static final int MAX_ENTRIES = 2048;
    private static final Map<String, OwnedBlock> OWNED = new LinkedHashMap<>();
    private static boolean loaded;
    private static Path file;

    private OwnedBlockRegistry() { }

    public static synchronized boolean isOwned(Minecraft client, BlockPos position, String actualBlockId) {
        ensureLoaded();
        if (client == null || client.level == null) return false;
        String dimension = client.level.dimension().identifier().toString();
        OwnedBlock owned = OWNED.get(key(dimension, position));
        return owned != null && owned.blockId().equals(actualBlockId);
    }

    public static synchronized void registerPlacedStructure(Minecraft client, BlockPos primary, String expectedBlockId) {
        ensureLoaded();
        if (client == null || client.level == null || primary == null || expectedBlockId == null) return;
        String dimension = client.level.dimension().identifier().toString();
        for (BlockPos candidate : List.of(
            primary, primary.north(), primary.south(), primary.west(), primary.east(), primary.above(), primary.below()
        )) {
            if (!client.level.isLoaded(candidate)) continue;
            BlockState observed = client.level.getBlockState(candidate);
            String actual = BuiltInRegistries.BLOCK.getKey(observed.getBlock()).toString();
            if (expectedBlockId.equals(actual)) {
                OWNED.put(key(dimension, candidate), new OwnedBlock(dimension, candidate.immutable(), actual));
            }
        }
        while (OWNED.size() > MAX_ENTRIES) OWNED.remove(OWNED.keySet().iterator().next());
        persist();
    }

    private static void ensureLoaded() {
        if (loaded) return;
        loaded = true;
        String configured = System.getenv("MCAI_OWNED_BLOCKS_FILE");
        if (configured == null || configured.isBlank()) return;
        try {
            file = Path.of(configured).toAbsolutePath().normalize();
            if (!Files.isRegularFile(file) || Files.size(file) > 512 * 1024L) return;
            JsonObject root = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
            if (!root.has("schemaVersion") || root.get("schemaVersion").getAsInt() != 1 || !root.has("blocks")) return;
            for (var element : root.getAsJsonArray("blocks")) {
                if (!element.isJsonObject() || OWNED.size() >= MAX_ENTRIES) break;
                JsonObject entry = element.getAsJsonObject();
                String dimension = entry.get("dimension").getAsString();
                String blockId = entry.get("blockId").getAsString();
                if (!dimension.matches("[a-z0-9_.-]+:[a-z0-9_./-]+") || !blockId.matches("[a-z0-9_.-]+:[a-z0-9_./-]+")) continue;
                BlockPos position = new BlockPos(entry.get("x").getAsInt(), entry.get("y").getAsInt(), entry.get("z").getAsInt());
                OWNED.put(key(dimension, position), new OwnedBlock(dimension, position, blockId));
            }
        } catch (Exception ignored) {
            OWNED.clear();
        }
    }

    private static void persist() {
        if (file == null) return;
        Path temporary = null;
        try {
            Path parent = file.getParent();
            if (parent == null) return;
            Files.createDirectories(parent);
            JsonObject root = new JsonObject();
            root.addProperty("schemaVersion", 1);
            JsonArray blocks = new JsonArray();
            for (OwnedBlock owned : OWNED.values()) {
                JsonObject entry = new JsonObject();
                entry.addProperty("dimension", owned.dimension());
                entry.addProperty("x", owned.position().getX());
                entry.addProperty("y", owned.position().getY());
                entry.addProperty("z", owned.position().getZ());
                entry.addProperty("blockId", owned.blockId());
                blocks.add(entry);
            }
            root.add("blocks", blocks);
            temporary = Files.createTempFile(parent, ".mcai-owned-blocks-", ".tmp");
            Files.writeString(temporary, root.toString(), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception ignored) {
            if (temporary != null) {
                try { Files.deleteIfExists(temporary); } catch (Exception ignoredDelete) { }
            }
        }
    }

    private static String key(String dimension, BlockPos position) {
        return dimension + "|" + position.getX() + "|" + position.getY() + "|" + position.getZ();
    }
}
