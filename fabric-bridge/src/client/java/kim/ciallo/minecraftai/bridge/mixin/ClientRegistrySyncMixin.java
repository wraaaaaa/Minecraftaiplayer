package kim.ciallo.minecraftai.bridge.mixin;

import net.fabricmc.fabric.impl.client.registry.sync.ClientRegistrySyncHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Lets the headless bot join a modded server without installing every server mod.
 *
 * Fabric API's registry sync normally aborts the connection when the server sends
 * registry entries the client does not know (e.g. blocks/sounds from server-side mods).
 * We keep the sync itself running (so the configuration phase completes) and only
 * skip the remote-remap check that throws on unknown entries. The bot does not render
 * custom content, so a best-effort local mapping of the remaining vanilla entries is fine.
 *
 * The flag travels through the environment (set by start-headless-client.ps1) because
 * HeadlessMc launches the real client in a separate JVM and does not forward arbitrary
 * -D system properties; environment variables survive the hand-off.
 */
@Mixin(ClientRegistrySyncHandler.class)
abstract class ClientRegistrySyncMixin {
    @Inject(method = "checkRemoteRemap", at = @At("HEAD"), cancellable = true)
    private static void minecraftAi$skipRemoteRemapCheck(CallbackInfo callback) {
        if ("true".equalsIgnoreCase(System.getenv("MCAI_SKIP_REGISTRY_SYNC"))) {
            callback.cancel();
        }
    }
}
