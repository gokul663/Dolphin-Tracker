import math
from typing import Dict, List


def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    value = (math.sin(dlat / 2) ** 2
             + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
             * math.sin(dlng / 2) ** 2)
    return radius * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def distance(a: dict, b: dict) -> float:
    return haversine(a["lat"], a["lng"], b["lat"], b["lng"])


def center(rows: List[dict]) -> tuple:
    return (
        sum(row["lat"] for row in rows) / len(rows),
        sum(row["lng"] for row in rows) / len(rows),
    )


def route_miles(route: List[dict]) -> float:
    return sum(distance(route[i - 1], route[i]) for i in range(1, len(route)))


def nearest_neighbor(rows: List[dict], anchor: dict = None) -> List[dict]:
    if len(rows) <= 1:
        return rows[:]
    if anchor is None:
        starts = rows
    else:
        starts = [min(rows, key=lambda row: distance(anchor, row))]

    best_route, best_length = rows[:], float("inf")
    for first in starts:
        remaining = rows[:]
        remaining.remove(first)
        route = [first]
        while remaining:
            next_stop = min(remaining, key=lambda row: distance(route[-1], row))
            route.append(next_stop)
            remaining.remove(next_stop)
        length = route_miles(route) + (distance(anchor, route[0]) if anchor else 0)
        if length < best_length:
            best_route, best_length = route, length
    return best_route


def two_opt(route: List[dict], max_passes: int = 30) -> List[dict]:
    if len(route) <= 3:
        return route[:]
    best = route[:]
    best_length = route_miles(best)
    for _ in range(max_passes):
        improved = False
        for i in range(1, len(best) - 2):
            for j in range(i + 1, len(best) - 1):
                candidate = best[:i] + best[i:j + 1][::-1] + best[j + 1:]
                length = route_miles(candidate)
                if length + 1e-6 < best_length:
                    best, best_length, improved = candidate, length, True
        if not improved:
            break
    return best


def optimize_route(rows: List[dict], anchor: dict = None) -> List[dict]:
    return two_opt(nearest_neighbor(rows, anchor))


def split_sizes(total: int, capacity: int) -> List[int]:
    count = math.ceil(total / capacity)
    base, extra = divmod(total, count)
    return [base + (1 if i < extra else 0) for i in range(count)]


def farthest_first_seeds(rows: List[dict], count: int) -> List[dict]:
    if count >= len(rows):
        return rows[:]
    latitude, longitude = center(rows)
    seeds = [max(rows, key=lambda row: haversine(latitude, longitude, row["lat"], row["lng"]))]
    while len(seeds) < count:
        candidates = [row for row in rows if row not in seeds]
        seeds.append(max(candidates, key=lambda row: min(distance(row, seed) for seed in seeds)))
    return seeds


def capacity_clusters(rows: List[dict], sizes: List[int], max_iter: int = 35) -> List[List[dict]]:
    seeds = farthest_first_seeds(rows, len(sizes))
    centers = [(row["lat"], row["lng"]) for row in seeds]
    previous = None
    clusters = []
    for _ in range(max_iter):
        remaining = sizes[:]
        clusters = [[] for _ in sizes]
        ranked = []
        for row in rows:
            distances = [haversine(row["lat"], row["lng"], *point) for point in centers]
            order = sorted(range(len(centers)), key=lambda index: distances[index])
            margin = distances[order[1]] - distances[order[0]] if len(order) > 1 else float("inf")
            ranked.append((margin, str(row.get("id", "")), row, order))
        for _, _, row, order in sorted(ranked, reverse=True, key=lambda item: (item[0], item[1])):
            target = next((index for index in order if remaining[index]), min(range(len(sizes)), key=lambda i: len(clusters[i])))
            clusters[target].append(row)
            remaining[target] = max(0, remaining[target] - 1)
        signature = tuple(tuple(sorted(str(row.get("id", "")) for row in cluster)) for cluster in clusters)
        if signature == previous:
            break
        previous = signature
        centers = [center(cluster) if cluster else centers[i] for i, cluster in enumerate(clusters)]
    return [cluster for cluster in clusters if cluster]


def geographic_clusters(rows: List[dict], count: int, max_iter: int = 50) -> List[List[dict]]:
    """Create natural territories without forcing equal stop counts."""
    if not rows or count <= 0:
        return []
    count = min(count, len(rows))
    seeds = farthest_first_seeds(rows, count)
    centers = [(row["lat"], row["lng"]) for row in seeds]
    previous = None
    clusters = []
    for _ in range(max_iter):
        clusters = [[] for _ in range(count)]
        for row in rows:
            target = min(
                range(count),
                key=lambda index: haversine(row["lat"], row["lng"], *centers[index]),
            )
            clusters[target].append(row)

        # Do not allow an empty territory when there are enough stops.
        for empty_index, cluster in enumerate(clusters):
            if cluster:
                continue
            donor_index = max(range(count), key=lambda index: len(clusters[index]))
            donor_center = centers[donor_index]
            moved = max(
                clusters[donor_index],
                key=lambda row: haversine(row["lat"], row["lng"], *donor_center),
            )
            clusters[donor_index].remove(moved)
            clusters[empty_index].append(moved)

        signature = tuple(
            tuple(sorted(str(row.get("id", "")) for row in cluster))
            for cluster in clusters
        )
        if signature == previous:
            break
        previous = signature
        centers = [center(cluster) for cluster in clusters]

    # Stable north-to-south, then west-to-east ordering keeps installer names
    # attached deterministically without relying on city or state names.
    return sorted(clusters, key=lambda cluster: (-center(cluster)[0], center(cluster)[1]))


def order_clusters_for_continuity(clusters: List[List[dict]]) -> List[List[dict]]:
    if not clusters:
        return []
    best_days, best_score = None, float("inf")
    for start in range(len(clusters)):
        remaining = [i for i in range(len(clusters)) if i != start]
        days = [optimize_route(clusters[start])]
        score = route_miles(days[0])
        while remaining:
            anchor = days[-1][-1]
            candidates = []
            for index in remaining:
                route = optimize_route(clusters[index], anchor)
                candidates.append((distance(anchor, route[0]) + route_miles(route), index, route))
            cost, index, route = min(candidates, key=lambda item: item[0])
            days.append(route)
            score += cost
            remaining.remove(index)
        if score < best_score:
            best_days, best_score = days, score
    return best_days


def orient_day_directions(days: List[List[dict]]) -> List[List[dict]]:
    """Reverse day routes as needed to minimize gaps between consecutive days."""
    if len(days) <= 1:
        return [day[:] for day in days]

    variants = [[day[:], list(reversed(day))] if len(day) > 1 else [day[:], day[:]] for day in days]
    costs = [[0.0, 0.0]]
    parents = [[None, None]]
    for index in range(1, len(days)):
        row_costs = [float("inf"), float("inf")]
        row_parents = [None, None]
        for current_direction in range(2):
            current = variants[index][current_direction]
            for previous_direction in range(2):
                previous = variants[index - 1][previous_direction]
                candidate = costs[index - 1][previous_direction] + distance(previous[-1], current[0])
                if candidate < row_costs[current_direction]:
                    row_costs[current_direction] = candidate
                    row_parents[current_direction] = previous_direction
        costs.append(row_costs)
        parents.append(row_parents)

    direction = min(range(2), key=lambda value: costs[-1][value])
    selected = [direction]
    for index in range(len(days) - 1, 0, -1):
        direction = parents[index][direction]
        selected.append(direction)
    selected.reverse()
    return [variants[index][direction] for index, direction in enumerate(selected)]


def improve_day_boundaries(days: List[List[dict]], max_iter: int = 20) -> List[List[dict]]:
    days = [day[:] for day in days]
    for _ in range(max_iter):
        improved = False
        for index in range(len(days) - 1):
            first, second = days[index], days[index + 1]
            if len(first) < 2 or len(second) < 2:
                continue
            best_score = route_miles(first) + route_miles(second)
            best_pair = None
            first_candidates = first[:3] + first[-3:] if len(first) > 6 else first
            second_candidates = second[:3] + second[-3:] if len(second) > 6 else second
            for left in {str(row.get("id")): row for row in first_candidates}.values():
                for right in {str(row.get("id")): row for row in second_candidates}.values():
                    new_first = optimize_route([right if row is left else row for row in first])
                    new_second = optimize_route([left if row is right else row for row in second])
                    score = route_miles(new_first) + route_miles(new_second)
                    if score + 0.25 < best_score:
                        best_score, best_pair = score, (new_first, new_second)
            if best_pair:
                days[index], days[index + 1] = best_pair
                improved = True
        if not improved:
            break
    return days


def make_day_batches(rows: List[dict], per_day: int = 9) -> List[List[dict]]:
    if not rows:
        return []
    clusters = capacity_clusters(rows, split_sizes(len(rows), per_day))
    days = improve_day_boundaries([optimize_route(cluster) for cluster in clusters])
    days = order_clusters_for_continuity(days)
    return orient_day_directions(order_clusters_for_continuity(improve_day_boundaries(days)))


def optimize_existing_day(rows: List[dict]) -> List[dict]:
    """Optimize stop order without changing which day each stop belongs to."""
    located = [row for row in rows if row.get("lat") is not None and row.get("lng") is not None]
    missing = [row for row in rows if row not in located]
    return optimize_route(located) + missing


def reassign_stop_preserving_days(
    routes: Dict[str, List[List[dict]]],
    stop_id: str,
    target_installer: str,
    per_day: int = 9,
) -> tuple:
    """Move one stop while keeping every unrelated stop on its current day."""
    copied = {
        installer: [[dict(stop) for stop in day] for day in days]
        for installer, days in routes.items()
    }
    matches = []
    for installer, days in copied.items():
        for day_index, day in enumerate(days):
            for stop_index, stop in enumerate(day):
                if str(stop.get("id")) == str(stop_id):
                    matches.append((installer, day_index, stop_index, stop))

    if not matches:
        raise LookupError("Stop not found")
    if len(matches) > 1:
        raise ValueError("Stop ID is not unique")
    if target_installer not in copied:
        raise KeyError("Installer is not assigned to this project")

    old_installer, old_day_index, stop_index, moved = matches[0]
    if old_installer == target_installer:
        return copied, moved, old_installer

    source_day = copied[old_installer][old_day_index]
    source_day.pop(stop_index)
    moved["installer"] = target_installer

    target_days = copied[target_installer]
    available = [index for index, day in enumerate(target_days) if len(day) < per_day]
    if available:
        if moved.get("lat") is not None and moved.get("lng") is not None:
            def proximity(day_index):
                located = [
                    stop for stop in target_days[day_index]
                    if stop.get("lat") is not None and stop.get("lng") is not None
                ]
                return min((distance(moved, stop) for stop in located), default=0)
            target_day_index = min(available, key=lambda index: (proximity(index), len(target_days[index]), index))
        else:
            target_day_index = min(available, key=lambda index: (len(target_days[index]), index))
    else:
        target_days.append([])
        target_day_index = len(target_days) - 1

    target_days[target_day_index].append(moved)

    if source_day:
        copied[old_installer][old_day_index] = optimize_existing_day(source_day)
    else:
        copied[old_installer].pop(old_day_index)
    copied[target_installer][target_day_index] = optimize_existing_day(target_days[target_day_index])

    for installer, days in copied.items():
        for day_number, day in enumerate(days, start=1):
            for stop in day:
                stop["installer"] = installer
                stop["day"] = day_number

    return copied, moved, old_installer


def rebalance_incomplete_routes(
    routes: Dict[str, List[List[dict]]],
    incomplete_ids: set,
    installers: List[str],
    per_day: int = 9,
    assignments_override: Dict[str, List[dict]] = None,
) -> Dict[str, List[List[dict]]]:
    """Redistribute only incomplete stops while preserving all other assignments."""
    all_stops = [dict(stop) for days in routes.values() for day in days for stop in day]
    incomplete = [stop for stop in all_stops if str(stop.get("id")) in incomplete_ids]
    fixed = [stop for stop in all_stops if str(stop.get("id")) not in incomplete_ids]
    assignments = assignments_override or assign_installers(incomplete, installers)
    balanced = {}

    for installer in installers:
        fixed_days = {}
        for stop in fixed:
            if stop.get("installer") != installer:
                continue
            try:
                day_number = max(1, int(stop.get("day", 1)))
            except (TypeError, ValueError):
                day_number = 1
            fixed_days.setdefault(day_number, []).append(stop)

        assigned = assignments.get(installer, [])
        day_count = max(fixed_days, default=0)
        days = [fixed_days.get(index, [])[:] for index in range(1, day_count + 1)]
        located = [stop for stop in assigned if stop.get("lat") is not None and stop.get("lng") is not None]
        pending_days = make_day_batches(located, per_day)
        missing = [stop for stop in assigned if stop not in located]
        for stop in missing:
            if not pending_days or len(pending_days[-1]) >= per_day:
                pending_days.append([])
            pending_days[-1].append(stop)

        # Completed and other non-pending stops stay on their recorded days,
        # but only pending stops consume the daily route capacity.
        used_days = set()
        for cluster in pending_days:
            available = [index for index in range(len(days)) if index not in used_days]
            if not available:
                days.append([])
                target = len(days) - 1
            else:
                def cluster_proximity(day_index):
                    fixed_located = [
                        stop for stop in days[day_index]
                        if stop.get("lat") is not None and stop.get("lng") is not None
                    ]
                    cluster_located = [
                        stop for stop in cluster
                        if stop.get("lat") is not None and stop.get("lng") is not None
                    ]
                    if not fixed_located or not cluster_located:
                        return float("inf")
                    return min(distance(left, right) for left in fixed_located for right in cluster_located)

                target = min(available, key=lambda index: (cluster_proximity(index), index))
            days[target] = cluster[:] + days[target]
            used_days.add(target)

        ordered_days = []
        for day in days:
            if not day:
                continue
            pending = [stop for stop in day if str(stop.get("id")) in incomplete_ids]
            historical = [stop for stop in day if str(stop.get("id")) not in incomplete_ids]
            ordered_days.append(optimize_existing_day(pending) + optimize_existing_day(historical))
        days = ordered_days
        for day_number, day in enumerate(days, start=1):
            for stop in day:
                stop["installer"] = installer
                stop["day"] = day_number
        balanced[installer] = days

    return balanced


def split_territory_for_new_installer(
    routes: Dict[str, List[List[dict]]],
    incomplete_ids: set,
    existing_installers: List[str],
    new_installer: str,
) -> Dict[str, List[dict]]:
    """Give a new installer one coherent cluster from the busiest territory."""
    assignments = {installer: [] for installer in existing_installers + [new_installer]}
    for installer in existing_installers:
        assignments[installer] = [
            dict(stop) for day in routes.get(installer, []) for stop in day
            if str(stop.get("id")) in incomplete_ids
        ]

    donor = max(existing_installers, key=lambda name: len(assignments[name]), default=None)
    if not donor or len(assignments[donor]) < 2:
        return assignments

    donor_stops = assignments[donor]
    located = [stop for stop in donor_stops if stop.get("lat") is not None and stop.get("lng") is not None]
    missing = [stop for stop in donor_stops if stop not in located]
    if len(located) >= 2:
        first_size = math.ceil(len(located) / 2)
        clusters = capacity_clusters(located, [first_size, len(located) - first_size])
        assignments[donor] = clusters[0] if clusters else located
        assignments[new_installer] = clusters[1] if len(clusters) > 1 else []
    else:
        split = math.ceil(len(donor_stops) / 2)
        assignments[donor] = donor_stops[:split]
        assignments[new_installer] = donor_stops[split:]

    for index, stop in enumerate(missing):
        target = donor if index % 2 == 0 else new_installer
        assignments[target].append(stop)
    return assignments


def preserve_installer_assignments(
    routes: Dict[str, List[List[dict]]],
    incomplete_ids: set,
    installers: List[str],
) -> Dict[str, List[dict]]:
    return {
        installer: [
            dict(stop) for day in routes.get(installer, []) for stop in day
            if str(stop.get("id")) in incomplete_ids
        ]
        for installer in installers
    }


def clean_territory_outliers(
    routes: Dict[str, List[List[dict]]],
    incomplete_ids: set,
    installers: List[str],
) -> Dict[str, List[dict]]:
    """Assign incomplete stops to the nearest robust center of current territories."""
    current = preserve_installer_assignments(routes, incomplete_ids, installers)

    def median(values):
        ordered = sorted(values)
        middle = len(ordered) // 2
        if len(ordered) % 2:
            return ordered[middle]
        return (ordered[middle - 1] + ordered[middle]) / 2

    centers = {}
    for installer, stops in current.items():
        located = [stop for stop in stops if stop.get("lat") is not None and stop.get("lng") is not None]
        if located:
            centers[installer] = (
                median([stop["lat"] for stop in located]),
                median([stop["lng"] for stop in located]),
            )

    assignments = {installer: [] for installer in installers}
    for owner, stops in current.items():
        for stop in stops:
            if stop.get("lat") is None or stop.get("lng") is None or not centers:
                assignments[owner].append(stop)
                continue
            target = min(
                centers,
                key=lambda installer: haversine(
                    stop["lat"], stop["lng"], centers[installer][0], centers[installer][1]
                ),
            )
            assignments[target].append(stop)
    return assignments


def assign_installers(stops: List[dict], installers: List[str]) -> Dict[str, List[dict]]:
    assignments = {installer: [] for installer in installers}
    if not installers:
        return assignments
    valid = [stop for stop in stops if stop.get("lat") is not None and stop.get("lng") is not None]
    invalid = [stop for stop in stops if stop not in valid]
    if valid:
        clusters = geographic_clusters(valid, min(len(valid), len(installers)))
        for installer, cluster in zip(installers, clusters):
            assignments[installer].extend(cluster)
    for index, stop in enumerate(invalid):
        assignments[installers[index % len(installers)]].append(stop)
    return assignments


def build_project_routes(stops: List[dict], installers: List[str], per_day: int = 9) -> Dict[str, List[List[dict]]]:
    routes = {}
    assignments = assign_installers(stops, installers)
    for installer in installers:
        assigned = assignments.get(installer, [])
        located = [stop for stop in assigned if stop.get("lat") is not None and stop.get("lng") is not None]
        days = make_day_batches(located, per_day)
        missing = [stop for stop in assigned if stop not in located]
        if missing:
            if not days:
                days = [[]]
            days[-1].extend(missing)
        for day_number, day in enumerate(days, start=1):
            for stop in day:
                stop["installer"] = installer
                stop["day"] = day_number
                stop.setdefault("assigned_region", "")
        routes[installer] = days
    return routes
