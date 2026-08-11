package kim.ciallo.minecraftai.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

import java.util.List;

/** Selects the correct mining family from the entire inventory, not merely the hotbar. */
final class ToolSelector {
    private ToolSelector() { }

    /**
     * Returns true only when the best available tool is already server-selected. A false
     * result after a backpack swap tells the caller to wait one tick before mining.
     */
    static boolean ensureBestMiningTool(Minecraft client, LocalPlayer player, BlockState state) {
        if (client == null || client.gameMode == null || player == null || state == null) return false;
        Candidate best = bestCandidate(player, state);
        if (best == null) return true;
        if (Inventory.isHotbarSlot(best.slot())) {
            select(player, best.slot());
            return true;
        }
        if (player.containerMenu != player.inventoryMenu || !player.inventoryMenu.getCarried().isEmpty()) return false;
        int destination = swapDestination(player, state);
        client.gameMode.handleContainerInput(
            player.inventoryMenu.containerId,
            best.slot(),
            destination,
            ContainerInput.SWAP,
            player
        );
        return false;
    }

    private static Candidate bestCandidate(LocalPlayer player, BlockState state) {
        Candidate best = null;
        List<ItemStack> items = player.getInventory().getNonEquipmentItems();
        for (int slot = 0; slot < items.size() && slot < Inventory.INVENTORY_SIZE; slot++) {
            double score = score(items.get(slot), state);
            if (!Double.isFinite(score)) continue;
            if (best == null || score > best.score() + 0.0001D
                || Math.abs(score - best.score()) <= 0.0001D
                    && Inventory.isHotbarSlot(slot) && !Inventory.isHotbarSlot(best.slot())) {
                best = new Candidate(slot, score);
            }
        }
        return best;
    }

    private static int swapDestination(LocalPlayer player, BlockState state) {
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            if (player.getInventory().getItem(slot).isEmpty()) return slot;
        }
        int destination = player.getInventory().getSelectedSlot();
        double lowest = Double.POSITIVE_INFINITY;
        for (int slot = 0; slot < Inventory.getSelectionSize(); slot++) {
            double score = score(player.getInventory().getItem(slot), state);
            if (score < lowest) {
                lowest = score;
                destination = slot;
            }
        }
        return destination;
    }

    private static double score(ItemStack stack, BlockState state) {
        if (stack == null || stack.isEmpty() || !stack.has(DataComponents.TOOL)) return Double.NEGATIVE_INFINITY;
        int remaining = stack.isDamageableItem() ? stack.getMaxDamage() - stack.getDamageValue() : Integer.MAX_VALUE;
        if (remaining <= 0) return Double.NEGATIVE_INFINITY;
        double score = stack.getDestroySpeed(state);
        // Correct drop capability dominates raw speed, preventing shovel-on-stone and
        // pickaxe-on-dirt choices whenever the matching tool exists.
        if (stack.isCorrectToolForDrops(state)) score += 10_000.0D;
        int enchantments = stack.getEnchantments().entrySet().stream().mapToInt(entry -> entry.getIntValue()).sum();
        // Prefer finishing a nearly worn-out correct tool instead of permanently hoarding it.
        // Minecraft removes the stack itself after the final legal use.
        double wearOutBonus = remaining <= 3 ? 100.0D : 0.0D;
        return score + wearOutBonus + enchantments * 0.01D;
    }

    private static void select(LocalPlayer player, int slot) {
        if (player.getInventory().getSelectedSlot() == slot) return;
        player.getInventory().setSelectedSlot(slot);
        player.connection.send(new ServerboundSetCarriedItemPacket(slot));
    }

    private record Candidate(int slot, double score) { }
}
