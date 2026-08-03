package kim.ciallo.minecraftai.bridge.mixin;

import kim.ciallo.minecraftai.bridge.MinecraftAiBridgeClient;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(LivingEntity.class)
abstract class LivingEntityDamageMixin {
    @Inject(method = "handleDamageEvent", at = @At("TAIL"))
    private void minecraftAi$reportPlayerAttack(DamageSource source, CallbackInfo callback) {
        if ((Object) this instanceof LocalPlayer && source.getEntity() instanceof Player attacker) {
            MinecraftAiBridgeClient.reportPlayerAttack(attacker);
        }
    }
}
