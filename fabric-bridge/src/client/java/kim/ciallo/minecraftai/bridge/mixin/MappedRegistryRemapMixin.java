package kim.ciallo.minecraftai.bridge.mixin;

import net.minecraft.core.MappedRegistry;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Skips Fabric's registry ID remap step when MCAI_SKIP_REGISTRY_SYNC=true.
 *
 * Fabric registry sync calls MappedRegistry#remap with the server's ID map; that
 * method throws RemapException when the map contains IDs unknown to the client.
 * The headless bot does not render custom content, so it can keep its vanilla ID
 * layout and still play. The checkRemoteRemap step is skipped separately so the
 * configuration phase can complete without aborting the connection.
 */
@Mixin(MappedRegistry.class)
abstract class MappedRegistryRemapMixin {
    @Inject(method = "remap", at = @At("HEAD"), cancellable = true)
    private void minecraftAi$skipRemap(CallbackInfo callback) {
        if ("true".equalsIgnoreCase(System.getenv("MCAI_SKIP_REGISTRY_SYNC"))) {
            callback.cancel();
        }
    }
}
