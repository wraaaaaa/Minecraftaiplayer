package kim.ciallo.minecraftai.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.waypoints.TrackedWaypoint;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/** 读取 Minecraft 为已配置所有者提供的、服务器同步的定位栏路标。 */
final class OwnerLocator {
    record Fix(String name, UUID uuid, double bearingDegrees, double distance, String precision) {
        Vec3 segmentGoal(LocalPlayer player, double maximumDistance) {
            double step = Double.isFinite(distance)
                ? Math.max(0.0D, Math.min(maximumDistance, distance))
                : maximumDistance;
            double radians = Math.toRadians(bearingDegrees);
            return new Vec3(
                player.getX() - Math.sin(radians) * step,
                player.getY(),
                player.getZ() + Math.cos(radians) * step
            );
        }
    }

    private OwnerLocator() { }

    static Fix locate(Minecraft client, LocalPlayer player, String ownerName) {
        if (client == null || client.level == null || player == null || player.connection == null
            || ownerName == null || ownerName.isBlank()) return null;
        PlayerInfo information = player.connection.getPlayerInfoIgnoreCase(ownerName);
        if (information == null || information.getProfile() == null) return null;
        UUID ownerId = information.getProfile().id();
        if (ownerId == null || ownerId.equals(player.getUUID())) return null;

        AtomicReference<Fix> found = new AtomicReference<>();
        player.connection.getWaypointManager().forEachWaypoint(player, waypoint -> {
            UUID waypointId = waypoint.id().left().orElse(null);
            if (!ownerId.equals(waypointId)) return;
            TrackedWaypoint.Camera camera = new TrackedWaypoint.Camera() {
                @Override public float yaw() { return 0.0F; }
                @Override public Vec3 position() { return player.position(); }
            };
            double bearing = waypoint.yawAngleToCamera(client.level, camera, entity -> 0.0F);
            double squared = waypoint.distanceSquared(player);
            double distance = Double.isFinite(squared) && squared >= 0.0D ? Math.sqrt(squared) : Double.POSITIVE_INFINITY;
            String className = waypoint.getClass().getSimpleName().toLowerCase();
            String precision = className.contains("vec3") ? "position"
                : className.contains("chunk") ? "chunk"
                : className.contains("azimuth") ? "azimuth"
                : "unknown";
            found.set(new Fix(information.getProfile().name(), ownerId, bearing, distance, precision));
        });
        return found.get();
    }
}
