package kim.ciallo.minecraftai.bridge;

import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;

import java.util.Set;

/**
  * 供 make_inventory_room 与 accept_items 使用的确定性背包分诊。当背包已满且
  * 必须拾取物品时，bot 可以丢弃优先级最低的物品堆。任何有价值的东西都不会被
  * 自动丢弃：附魔装备、安全食物、未损坏的工具以及未知物品都一律不会被
  * 动用。
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

    /** 在填充方块变得可丢弃之前，为搭脚手架和紧急建造保留的储备。 */
    private static final int FILLER_RESERVE = 16;

    private InventoryCleanup() { }

    static int freeSlots(LocalPlayer player) {
        int free = 0;
        for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
            if (stack.isEmpty()) free++;
        }
        return free;
    }

    /** 数值越小表示越先被丢弃。Integer.MAX_VALUE 表示永不自动丢弃。 */
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

    /** 挑选单个最差（优先级最低）的可丢弃背包槽位；没有时返回 -1。 */
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
