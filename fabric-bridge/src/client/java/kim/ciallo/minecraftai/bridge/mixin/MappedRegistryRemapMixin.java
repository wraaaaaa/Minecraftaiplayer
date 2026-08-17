package kim.ciallo.minecraftai.bridge.mixin;

import net.minecraft.core.MappedRegistry;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
  * 当 MCAI_SKIP_REGISTRY_SYNC=true 时跳过 Fabric 的注册表 ID 重映射步骤。
  *
  * Fabric 的注册表同步会使用服务器的 ID 映射调用 MappedRegistry#remap；当映射
  * 中包含客户端未知的 ID 时，该方法会抛出 RemapException。无头 bot 不渲染
  * 自定义内容，因此可以保留其原版 ID 布局并继续游玩。checkRemoteRemap 步骤
  * 被单独跳过，以便配置阶段能够在不中止连接的情况下完成。
  * 这样连接就不会被中止。
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
