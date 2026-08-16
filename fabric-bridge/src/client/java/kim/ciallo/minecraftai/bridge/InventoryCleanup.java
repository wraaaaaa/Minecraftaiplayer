package kim.ciallo.minecraftai.bridge;

import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;

import java.util.Set;

/**
 * Deterministic inventory triage used by make_inventory_room and accept_items. The bot may
 * discard the lowest-priority stacks when the backpack is full and it must pick something up.
 * Nothing valuable is ever auto-discarded: enchanted gear, safe food, undamaged tools and
 * unknown items are all off-limits.
 */
final class InventoryCleanup {
    private static final Set<String> UNSAFE_FOOD = Set.of(
        "minecraft:rotten_flesh", "minecraft:spider_eye", "minecraft:poisonous_potato",
        "minecraft:pufferfish", "minecraft:chicken", "minecraft:suspicious_stew", "minecraft:chorus_fruit"
    );

    private static final Set<String> FILLER_BLOCKS = Set.of(
        "minecraft:cobblestone", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:gravel",
        "minecraft:sand", "minecraft:red_sand", "minecraft:netherrack", "minecraft:deepslate",
        "minecraft:cobbled_deepslate", "minecraft:tuff", "minecraft:granite", "minecraft:diorite",
        "minecraft:andesite", "minecraft:stone", "minecraft:grass_block", "minecraft:mud"
    );

    /** Reserve kept for scaffolding and emergency building before filler becomes disposable. */
    private static final int FILLER_RESERVE = 16;

    private InventoryCleanup() { }

    static int freeSlots(LocalPlayer player) {
        int free = 0;
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (stack.isEmpty()) free++;
        }
        return free;
    }

    /** Lower value means discard sooner. Integer.MAX_VALUE means never auto-discard. */
    static int discardPriority(ItemStack stack, int countInInventory) {
        if (stack.isEmpty()) return Integer.MAX_VALUE;
        if (!stack.getEnchantments().isEmpty()) return Integer.MAX_VALUE;
        String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();

        if (stack.isDamageableItem() && stack.getMaxDamage() > 0
            && (stack.has(DataComponents.TOOL) || stack.has(DataComponents.WEAPON))) {
            int remaining = stack.getMaxDamage() - stack.getDamageValue();
            if (remaining <= 2) return 0;
            return Integer.MAX_VALUE;
        }
        if (UNSAFE_FOOD.contains(id)) return 10;
        if (FILLER_BLOCKS.contains(id)) return countInInventory > FILLER_RESERVE ? 20 : Integer.MAX_VALUE;
        return Integer.MAX_VALUE;
    }

    static String discardReason(ItemStack stack, int countInInventory) {
        int priority = discardPriority(stack, countInInventory);
        if (priority == Integer.MAX_VALUE) return "keep";
        if (priority == 0) return "worn_tool";
        if (priority == 10) return "unsafe_food";
        return "filler_excess";
    }

    /** Picks the single worst (lowest-priority) discardable backpack slot, or -1 when none. */
    static int discardableSlot(LocalPlayer player) {
        int bestSlot = -1;
        int bestPriority = Integer.MAX_VALUE;
        boolean bestIsHotbar = true;
        for (int slot = 0; slot < player.getInventory().getNonEquipmentItems().size(); slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (stack.isEmpty()) continue;
            String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
            int count = countOf(player, id);
            int priority = discardPriority(stack, count);
            if (priority == Integer.MAX_VALUE) continue;
            boolean hotbar = Inventory.isHotbarSlot(slot);
            if (priority < bestPriority || (priority == bestPriority && hotbar && !bestIsHotbar)) {
                bestPriority = priority;
                bestSlot = slot;
                bestIsHotbar = hotbar;
            }
        }
        return bestSlot;
    }

    private static int countOf(LocalPlayer player, String itemId) {
        int total = 0;
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (!stack.isEmpty() && BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(itemId)) {
                total += stack.getCount();
            }
        }
        return total;
    }
}
