package kim.ciallo.minecraftai.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

/**
 * Bounded A* navigator over collision-safe positions in the loaded client world.
 * Long routes are split into local segments and replanned as terrain or the goal changes.
 */
final class LocalPathNavigator {
    private static final Direction[] HORIZONTAL = {
        Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST
    };
    private static final int PLAN_RADIUS = 24;
    private static final int PLAN_VERTICAL_RADIUS = 6;
    private static final int MAX_EXPANDED_NODES = 6_000;
    private static final long PERIODIC_REPLAN_TICKS = 80L;
    private static final long STUCK_REPLAN_TICKS = 18L;

    private List<BlockPos> path = List.of();
    private int pathIndex;
    private Vec3 requestedGoal;
    private long lastPlanTick = Long.MIN_VALUE;
    private Vec3 progressPosition;
    private long lastProgressTick;
    private int consecutivePlanFailures;
    private String status = "idle";

    /** Drives one client tick. Returns false only when no safe route could be planned. */
    boolean drive(Minecraft client, LocalPlayer player, Vec3 goal, double stopDistance, boolean sprint, long tick) {
        if (client == null || client.level == null || player == null || goal == null) {
            release(client);
            status = "not_in_world";
            return false;
        }

        // Horizontal distance alone is not an arrival condition.  Treating a goal one block
        // below the player as reached made staircase mining report success while standing at
        // the original Y level.
        if (horizontalDistance(player.position(), goal) <= stopDistance
            && Math.abs(player.getY() - goal.y) <= 0.8D) {
            releaseControls(client);
            path = List.of();
            pathIndex = 0;
            requestedGoal = goal;
            status = "arrived";
            consecutivePlanFailures = 0;
            return true;
        }

        // A freshly placed scaffold can leave the player's body one block above the nearest
        // graph-supported floor while it overlaps the edge of the old ledge. In that state the
        // generic start-node projection sees a two-block rise and rejects an otherwise legal
        // vanilla one-block jump. Validate this very small move against the player's real AABB
        // and the destination instead of weakening A* transition rules globally.
        BlockPos directGoal = BlockPos.containing(goal.x, goal.y, goal.z);
        int dxBlocks = Math.abs(directGoal.getX() - player.blockPosition().getX());
        int dzBlocks = Math.abs(directGoal.getZ() - player.blockPosition().getZ());
        double directStandingY = standingY(client, directGoal);
        double directRise = directStandingY - player.getY();
        if (Math.max(dxBlocks, dzBlocks) == 1
            && horizontalDistance(player.position(), goal) <= 1.8D
            && directRise > 0.2D && directRise <= 1.25D
            && isStandable(client, player, directGoal)
            && client.level.noCollision(player, player.getBoundingBox().move(0.0D, directRise, 0.0D))) {
            releaseControls(client);
            Vec3 center = standingCenter(client, player, directGoal);
            lookAt(player, center.x, center.y, center.z, false);
            client.options.keyUp.setDown(true);
            // Holding jump is intentional: it also handles the tick where the server changes
            // onGround after the scaffold placement acknowledgement.
            client.options.keyJump.setDown(true);
            requestedGoal = goal;
            status = "direct_safe_step_up";
            consecutivePlanFailures = 0;
            return true;
        }

        boolean goalChanged = requestedGoal == null || horizontalDistance(requestedGoal, goal) > 1.25D
            || Math.abs(requestedGoal.y - goal.y) > 1.5D;
        requestedGoal = goal;
        boolean stuck = progressPosition != null
            && horizontalDistance(progressPosition, player.position()) < 0.18D
            && tick - lastProgressTick >= STUCK_REPLAN_TICKS;
        if (progressPosition == null || horizontalDistance(progressPosition, player.position()) >= 0.35D) {
            progressPosition = player.position();
            lastProgressTick = tick;
            stuck = false;
        }

        boolean periodic = tick - lastPlanTick >= PERIODIC_REPLAN_TICKS;
        boolean routeFinished = pathIndex >= path.size();
        boolean waypointInvalid = !routeFinished && !isStandable(client, player, path.get(pathIndex));
        if (routeFinished && consecutivePlanFailures > 0 && !goalChanged && tick - lastPlanTick < 10L) {
            releaseControls(client);
            return false;
        }
        boolean collisionNeedsReplan = player.horizontalCollision && tick - lastPlanTick >= 4L;
        if (goalChanged || routeFinished || periodic || stuck || waypointInvalid || collisionNeedsReplan) {
            if (!plan(client, player, goal, stopDistance, tick)) {
                releaseControls(client);
                status = "no_safe_route";
                consecutivePlanFailures++;
                return false;
            }
        }

        while (pathIndex < path.size()) {
            BlockPos waypoint = path.get(pathIndex);
            Vec3 waypointPosition = standingCenter(client, player, waypoint);
            double waypointDistance = horizontalDistance(player.position(), waypointPosition);
            if (waypointDistance > 0.42D || Math.abs(player.getY() - waypointPosition.y) > 0.8D) break;
            pathIndex++;
        }
        if (pathIndex >= path.size()) {
            releaseControls(client);
            status = "segment_complete";
            return true;
        }

        BlockPos waypoint = path.get(pathIndex);
        Vec3 waypointCenter = standingCenter(client, player, waypoint);
        releaseControls(client);
        boolean waterWaypoint = isWaterNode(client, waypoint);
        lookAt(player, waypointCenter.x, waypointCenter.y, waypointCenter.z, waterWaypoint || player.isInWater());

        double dx = waypointCenter.x - player.getX();
        double dz = waypointCenter.z - player.getZ();
        double length = Math.max(0.001D, Math.sqrt(dx * dx + dz * dz));
        AABB projected = player.getBoundingBox().move(dx / length * 0.32D, 0.0D, dz / length * 0.32D);
        boolean clearAhead = client.level.noCollision(player, projected);
        boolean stepUp = waypointCenter.y > player.getY() + 0.2D;
        if (!clearAhead && !stepUp) {
            // Never keep pressing into a wall. Invalidate immediately; the next tick routes around it.
            path = List.of();
            pathIndex = 0;
            status = "route_blocked_replan";
            return true;
        }

        client.options.keyUp.setDown(true);
        client.options.keySprint.setDown(sprint && !stepUp && pathIndex + 1 < path.size());
        if ((stepUp && player.onGround()) || (waterWaypoint && waypointCenter.y > player.getY() + 0.05D)) {
            client.options.keyJump.setDown(true);
        }
        status = "following_path " + (pathIndex + 1) + "/" + path.size();
        return true;
    }

    void release(Minecraft client) {
        releaseControls(client);
        path = List.of();
        pathIndex = 0;
        requestedGoal = null;
        progressPosition = null;
        consecutivePlanFailures = 0;
        status = "idle";
    }

    String status() {
        return status;
    }

    int consecutivePlanFailures() {
        return consecutivePlanFailures;
    }

    String diagnoseDirectStep(Minecraft client, LocalPlayer player, BlockPos goal) {
        if (client == null || client.level == null || player == null || goal == null) return "missing_world_or_goal";
        BlockPos start = nearestStandableStart(client, player);
        BlockPos origin = player.blockPosition();
        String startText = start == null ? "none" : start.toShortString();
        double startY = start == null ? Double.NaN : standingY(client, start);
        double goalY = standingY(client, goal);
        boolean goalStandable = isStandable(client, player, goal);
        boolean transition = start != null && transitionClear(client, player, start, goal);
        BlockState feet = client.level.getBlockState(goal);
        BlockState head = client.level.getBlockState(goal.above());
        BlockState support = client.level.getBlockState(goal.below());
        BlockState departureCeiling = client.level.getBlockState(origin.above(2));
        return "origin=" + origin.toShortString()
            + "; start=" + startText
            + "; goal=" + goal.toShortString()
            + "; standing_y=" + startY + "->" + goalY
            + "; goal_standable=" + goalStandable
            + "; transition_clear=" + transition
            + "; support=" + BuiltInRegistries.BLOCK.getKey(support.getBlock())
            + "; feet=" + BuiltInRegistries.BLOCK.getKey(feet.getBlock())
            + "; head=" + BuiltInRegistries.BLOCK.getKey(head.getBlock())
            + "; departure_ceiling=" + BuiltInRegistries.BLOCK.getKey(departureCeiling.getBlock());
    }

    private boolean plan(Minecraft client, LocalPlayer player, Vec3 goal, double stopDistance, long tick) {
        BlockPos start = nearestStandableStart(client, player);
        if (start == null) start = player.blockPosition();
        Vec3 segmentGoal = segmentGoal(start, goal);
        double segmentStop = horizontalDistance(center(start), goal) > PLAN_RADIUS
            ? 1.0D
            : Math.max(0.45D, stopDistance);
        List<BlockPos> nextPath = findPath(client, player, start, segmentGoal, segmentStop);
        lastPlanTick = tick;
        if (nextPath.isEmpty()) return false;
        path = nextPath;
        pathIndex = 0;
        progressPosition = player.position();
        lastProgressTick = tick;
        consecutivePlanFailures = 0;
        status = "planned " + path.size() + " waypoints";
        return true;
    }

    private List<BlockPos> findPath(Minecraft client, LocalPlayer player, BlockPos start, Vec3 goal, double stopDistance) {
        PriorityQueue<ScoredPosition> open = new PriorityQueue<>(Comparator.comparingDouble(ScoredPosition::score));
        Map<BlockPos, Double> cost = new HashMap<>();
        Map<BlockPos, BlockPos> previous = new HashMap<>();
        Set<BlockPos> closed = new HashSet<>();
        cost.put(start, 0.0D);
        open.add(new ScoredPosition(start, heuristic(start, goal, stopDistance)));
        BlockPos closest = start;
        double closestHeuristic = heuristic(start, goal, stopDistance);
        int expanded = 0;

        while (!open.isEmpty() && expanded++ < MAX_EXPANDED_NODES) {
            BlockPos current = open.poll().position();
            if (!closed.add(current)) continue;
            double currentHeuristic = heuristic(current, goal, stopDistance);
            if (currentHeuristic < closestHeuristic) {
                closest = current;
                closestHeuristic = currentHeuristic;
            }
            if (reached(current, goal, stopDistance)) return reconstruct(previous, current, start);

            for (Direction direction : HORIZONTAL) {
                int nextX = current.getX() + direction.getStepX();
                int nextZ = current.getZ() + direction.getStepZ();
                for (int dy : new int[] { 0, 1, -1 }) {
                    BlockPos next = new BlockPos(nextX, current.getY() + dy, nextZ);
                    if (Math.abs(next.getX() - start.getX()) > PLAN_RADIUS
                        || Math.abs(next.getZ() - start.getZ()) > PLAN_RADIUS
                        || Math.abs(next.getY() - start.getY()) > PLAN_VERTICAL_RADIUS
                        || closed.contains(next)
                        || !isStandable(client, player, next)
                        || !transitionClear(client, player, current, next)) continue;

                    double nextCost = cost.get(current) + 1.0D + Math.abs(dy) * 0.35D;
                    if (nextCost + 0.0001D >= cost.getOrDefault(next, Double.POSITIVE_INFINITY)) continue;
                    cost.put(next, nextCost);
                    previous.put(next, current);
                    open.add(new ScoredPosition(next, nextCost + heuristic(next, goal, stopDistance)));
                    break;
                }
            }
            if (isWaterNode(client, current)) {
                for (int dy : new int[] { 1, -1 }) {
                    BlockPos next = current.offset(0, dy, 0);
                    if (Math.abs(next.getY() - start.getY()) > PLAN_VERTICAL_RADIUS
                        || closed.contains(next)
                        || !isStandable(client, player, next)
                        || !transitionClear(client, player, current, next)) continue;
                    double nextCost = cost.get(current) + 1.35D;
                    if (nextCost + 0.0001D >= cost.getOrDefault(next, Double.POSITIVE_INFINITY)) continue;
                    cost.put(next, nextCost);
                    previous.put(next, current);
                    open.add(new ScoredPosition(next, nextCost + heuristic(next, goal, stopDistance)));
                }
            }
        }

        if (!closest.equals(start) && heuristic(start, goal, stopDistance) - closestHeuristic >= 2.0D) {
            return reconstruct(previous, closest, start);
        }
        return List.of();
    }

    private static BlockPos nearestStandableStart(Minecraft client, LocalPlayer player) {
        BlockPos origin = player.blockPosition();
        for (int dy : new int[] { 0, 1, -1 }) {
            BlockPos candidate = origin.offset(0, dy, 0);
            if (isStandable(client, player, candidate)) return candidate;
        }
        return null;
    }

    private static boolean isStandable(Minecraft client, LocalPlayer player, BlockPos position) {
        if (client.level == null || !client.level.isLoaded(position) || !client.level.isLoaded(position.below())) return false;
        boolean water = isWaterNode(client, position);
        double standingY = standingY(client, position);
        if (!Double.isFinite(standingY)) return false;
        AABB box = player.getBoundingBox();
        AABB atPosition = box.move(
            position.getX() + 0.5D - player.getX(),
            standingY - player.getY(),
            position.getZ() + 0.5D - player.getZ()
        );
        if (!client.level.noCollision(player, atPosition)) return false;
        if (!water && client.level.noCollision(player, atPosition.move(0.0D, -0.16D, 0.0D))) return false;
        return !isHazard(client.level.getBlockState(position)) && !isHazard(client.level.getBlockState(position.below()));
    }

    private static boolean transitionClear(Minecraft client, LocalPlayer player, BlockPos from, BlockPos to) {
        double fromY = standingY(client, from);
        double toY = standingY(client, to);
        if (!Double.isFinite(fromY) || !Double.isFinite(toY) || toY - fromY > 1.25D) return false;
        if (toY <= fromY + 0.01D) return true;
        AABB box = player.getBoundingBox();
        AABB raisedDeparture = box.move(
            from.getX() + 0.5D - player.getX(),
            toY - player.getY(),
            from.getZ() + 0.5D - player.getZ()
        );
        return client.level.noCollision(player, raisedDeparture);
    }

    /** Returns the actual collision-surface height, including slabs and snow layers. */
    private static double standingY(Minecraft client, BlockPos position) {
        if (client.level == null) return Double.NaN;
        if (isWaterNode(client, position)) return position.getY();
        double best = Double.NaN;
        BlockPos below = position.below();
        var belowShape = client.level.getBlockState(below).getCollisionShape(client.level, below);
        if (!belowShape.isEmpty()) best = below.getY() + belowShape.max(Direction.Axis.Y);

        var sameShape = client.level.getBlockState(position).getCollisionShape(client.level, position);
        if (!sameShape.isEmpty()) {
            double height = sameShape.max(Direction.Axis.Y);
            // Partial-height blocks occupy the nominal feet cell. Full cubes are represented by
            // the next BlockPos above so the graph does not create duplicate standing nodes.
            if (height > 0.0D && height < 0.99D) {
                double surface = position.getY() + height;
                best = Double.isFinite(best) ? Math.max(best, surface) : surface;
            }
        }
        return best;
    }

    private static Vec3 standingCenter(Minecraft client, LocalPlayer player, BlockPos position) {
        double y = standingY(client, position);
        if (!Double.isFinite(y)) y = position.getY();
        return new Vec3(position.getX() + 0.5D, y, position.getZ() + 0.5D);
    }

    private static boolean isHazard(BlockState state) {
        String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        return id.equals("minecraft:lava") || id.endsWith(":fire") || id.equals("minecraft:cactus")
            || id.equals("minecraft:magma_block") || id.equals("minecraft:sweet_berry_bush")
            || id.equals("minecraft:powder_snow") || id.endsWith("_campfire");
    }

    private static boolean isWaterNode(Minecraft client, BlockPos position) {
        return client != null && client.level != null && client.level.isLoaded(position)
            && client.level.getFluidState(position).is(FluidTags.WATER);
    }

    private static Vec3 segmentGoal(BlockPos start, Vec3 goal) {
        Vec3 startCenter = center(start);
        double dx = goal.x - startCenter.x;
        double dz = goal.z - startCenter.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        if (horizontal <= PLAN_RADIUS - 2.0D) return goal;
        double scale = (PLAN_RADIUS - 2.0D) / horizontal;
        return new Vec3(startCenter.x + dx * scale, goal.y, startCenter.z + dz * scale);
    }

    private static boolean reached(BlockPos position, Vec3 goal, double stopDistance) {
        return horizontalDistance(center(position), goal) <= stopDistance && Math.abs(position.getY() - goal.y) <= 0.8D;
    }

    private static double heuristic(BlockPos position, Vec3 goal, double stopDistance) {
        double horizontal = Math.max(0.0D, horizontalDistance(center(position), goal) - stopDistance);
        return horizontal + Math.abs(position.getY() - goal.y) * 0.25D;
    }

    private static List<BlockPos> reconstruct(Map<BlockPos, BlockPos> previous, BlockPos end, BlockPos start) {
        List<BlockPos> route = new ArrayList<>();
        BlockPos cursor = end;
        while (!cursor.equals(start)) {
            route.add(cursor);
            cursor = previous.get(cursor);
            if (cursor == null) return List.of();
        }
        Collections.reverse(route);
        return route;
    }

    private static Vec3 center(BlockPos position) {
        return new Vec3(position.getX() + 0.5D, position.getY(), position.getZ() + 0.5D);
    }

    private static double horizontalDistance(Vec3 first, Vec3 second) {
        double dx = first.x - second.x;
        double dz = first.z - second.z;
        return Math.sqrt(dx * dx + dz * dz);
    }

    private static void lookAt(LocalPlayer player, double x, double y, double z, boolean allowVerticalLook) {
        double dx = x - player.getX();
        double dz = z - player.getZ();
        player.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
        if (allowVerticalLook) {
            double horizontal = Math.max(0.001D, Math.sqrt(dx * dx + dz * dz));
            player.setXRot((float) -Math.toDegrees(Math.atan2(y - player.getEyeY(), horizontal)));
        } else {
            player.setXRot(0.0F);
        }
    }

    private static void releaseControls(Minecraft client) {
        if (client == null) return;
        client.options.keyUp.setDown(false);
        client.options.keyDown.setDown(false);
        client.options.keyLeft.setDown(false);
        client.options.keyRight.setDown(false);
        client.options.keyJump.setDown(false);
        client.options.keySprint.setDown(false);
        client.options.keyShift.setDown(false);
    }

    private record ScoredPosition(BlockPos position, double score) { }
}
