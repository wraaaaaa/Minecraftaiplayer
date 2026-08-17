package kim.ciallo.minecraftai.bridge.mixin;

import net.fabricmc.fabric.impl.client.registry.sync.ClientRegistrySyncHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
  * 让无头 bot 无需安装每个服务器 Mod 即可加入 Mod 服务器。
  *
  * Fabric API 的注册表同步通常在服务器发送客户端未知的注册表项
  * （例如来自服务器端 Mod 的方块/音效）时中止连接。我们让同步本身继续运行
  * （以便配置阶段完成），仅跳过会在遇到未知项时抛出异常的远程重映射检查。
  * 该 bot 不渲染自定义内容，因此对剩余原版项做一次尽力而为的
  * 本地映射即可。
  *
  * 该标志通过环境变量传递（由 start-headless-client.ps1 设置），因为
  * HeadlessMc 会在独立的 JVM 中启动真正的客户端，且不会转发任意的
  * -D 系统属性；而环境变量可以经受住这次交接。
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
