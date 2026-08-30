extends Node3D

const TERRAIN_COLORS := {
	"plain": Color("4a7845"), "forest": Color("295b35"),
	"hill": Color("6b5f4a"), "water": Color("1a5165"),
}
const STRUCTURE_COLORS := {
	"camp": Color("b8874f"), "storehouse": Color("8a7a5c"),
	"market": Color("cca347"), "workshop": Color("7d8782"),
}

@onready var world_root: Node3D = $WorldRoot
@onready var camera_rig: Node3D = $CameraRig
@onready var camera: Camera3D = $CameraRig/Camera3D
@onready var http: HTTPRequest = $HTTPRequest
@onready var poll_timer: Timer = $PollTimer
@onready var status_label: Label = $CanvasLayer/Status
@onready var details: RichTextLabel = $CanvasLayer/SidePanel/VBox/Details
@onready var pause_button: Button = $CanvasLayer/SidePanel/VBox/Buttons/PauseButton
@onready var tick_button: Button = $CanvasLayer/SidePanel/VBox/Buttons/TickButton

var api_base := "http://127.0.0.1:8787"
var region := "garden-1"
var token := ""
var socket := WebSocketPeer.new()
var state: Dictionary = {}
var terrain_key := ""
var selected_agent_id := ""
var agent_nodes: Dictionary = {}
var structure_nodes: Dictionary = {}
var paused := false
var request_in_flight := false
var orbit_yaw := -0.75
var orbit_pitch := 0.68
var orbit_distance := 34.0
var orbit_target := Vector3.ZERO
var dragging := false
var drag_moved := false
var drag_origin := Vector2.ZERO
var last_mouse := Vector2.ZERO
var reconnect_at := 0

func _ready() -> void:
	api_base = OS.get_environment("MOYO_API_URL").strip_edges()
	if api_base.is_empty(): api_base = "http://127.0.0.1:8787"
	region = OS.get_environment("MOYO_REGION").strip_edges()
	if region.is_empty(): region = "garden-1"
	token = OS.get_environment("MOYO_TOKEN").strip_edges()
	http.request_completed.connect(_on_snapshot_completed)
	poll_timer.timeout.connect(_poll_snapshot)
	pause_button.pressed.connect(_toggle_pause)
	tick_button.pressed.connect(func() -> void: _post_json("/api/admin/tick", {"count": 1}))
	connect_world()
	_poll_snapshot()
	_update_camera()

func _api_url(path: String) -> String:
	return "%s%s%sregion=%s" % [api_base.trim_suffix("/"), path, "&" if "?" in path else "?", region.uri_encode()]

func _ws_url() -> String:
	var base := api_base.trim_suffix("/")
	if base.begins_with("https://"): base = "wss://" + base.trim_prefix("https://")
	elif base.begins_with("http://"): base = "ws://" + base.trim_prefix("http://")
	return "%s/api/stream?region=%s" % [base, region.uri_encode()]

func _headers(json := false) -> PackedStringArray:
	var result := PackedStringArray()
	if json: result.append("Content-Type: application/json")
	if not token.is_empty(): result.append("Authorization: Bearer %s" % token)
	return result

func connect_world() -> void:
	socket = WebSocketPeer.new()
	var error := socket.connect_to_url(_ws_url())
	reconnect_at = Time.get_ticks_msec() + 4000
	status_label.text = "CONNECTING · %s" % region if error == OK else "WEBSOCKET ERROR · HTTP FALLBACK"

func _process(delta: float) -> void:
	socket.poll()
	if socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		while socket.get_available_packet_count() > 0:
			var parsed: Variant = JSON.parse_string(socket.get_packet().get_string_from_utf8())
			if parsed is Dictionary and parsed.get("type") == "snapshot" and parsed.get("state") is Dictionary:
				paused = bool(parsed.get("paused", false))
				_apply_snapshot(parsed.get("state"))
		status_label.text = "LIVE · %s · TICK %s" % [region, state.get("tick", "-")]
	elif socket.get_ready_state() == WebSocketPeer.STATE_CLOSED and Time.get_ticks_msec() >= reconnect_at:
		connect_world()
	_update_camera()

func _update_camera() -> void:
	orbit_pitch = clampf(orbit_pitch, 0.18, 1.28)
	orbit_distance = clampf(orbit_distance, 8.0, 76.0)
	var cp := cos(orbit_pitch)
	camera.global_position = orbit_target + Vector3(sin(orbit_yaw) * cp, sin(orbit_pitch), cos(orbit_yaw) * cp) * orbit_distance
	camera.look_at(orbit_target, Vector3.UP)

func _poll_snapshot() -> void:
	if request_in_flight: return
	request_in_flight = true
	if http.request(_api_url("/api/world/snapshot"), _headers()) != OK: request_in_flight = false

func _on_snapshot_completed(_result: int, code: int, _headers_value: PackedStringArray, body: PackedByteArray) -> void:
	request_in_flight = false
	if code < 200 or code >= 300: return
	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if parsed is Dictionary: _apply_snapshot(parsed)

func _apply_snapshot(snapshot: Dictionary) -> void:
	state = snapshot
	var key := "%s:%s:%s:%s" % [state.get("worldId", ""), state.get("seed", 0), state.get("width", 0), state.get("height", 0)]
	if key != terrain_key:
		terrain_key = key
		_rebuild_world()
	_sync_structures()
	_sync_agents()
	if selected_agent_id.is_empty() and not state.get("agents", []).is_empty():
		selected_agent_id = str(state.get("agents", [])[0].get("id", ""))
	_refresh_details()
	pause_button.text = "RESUME" if paused else "PAUSE"

func _clear_world() -> void:
	for child in world_root.get_children(): child.queue_free()
	agent_nodes.clear()
	structure_nodes.clear()

func _material(color: Color, roughness := 0.9) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	material.roughness = roughness
	return material

func _box(parent: Node3D, position: Vector3, size: Vector3, color: Color) -> MeshInstance3D:
	var mesh_instance := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = size
	mesh.material = _material(color)
	mesh_instance.mesh = mesh
	mesh_instance.position = position
	parent.add_child(mesh_instance)
	return mesh_instance

func _sphere(parent: Node3D, position: Vector3, radius: float, color: Color) -> MeshInstance3D:
	var mesh_instance := MeshInstance3D.new()
	var mesh := SphereMesh.new()
	mesh.radius = radius
	mesh.height = radius * 2.0
	mesh.radial_segments = 8
	mesh.rings = 5
	mesh.material = _material(color)
	mesh_instance.mesh = mesh
	mesh_instance.position = position
	parent.add_child(mesh_instance)
	return mesh_instance

func _terrain_height(kind: String) -> float:
	if kind == "hill": return 0.62
	if kind == "forest": return 0.14
	if kind == "water": return -0.20
	return 0.0

func _world_position(grid: Dictionary, lift := 0.0) -> Vector3:
	var x := int(grid.get("x", 0))
	var y := int(grid.get("y", 0))
	var tile := _tile_at(x, y)
	return Vector3(float(x) - float(state.get("width", 1)) / 2.0 + 0.5, _terrain_height(str(tile.get("terrain", "plain"))) + lift, float(y) - float(state.get("height", 1)) / 2.0 + 0.5)

func _tile_at(x: int, y: int) -> Dictionary:
	var width := int(state.get("width", 0))
	var height := int(state.get("height", 0))
	if x < 0 or y < 0 or x >= width or y >= height: return {}
	return state.get("tiles", [])[y * width + x]

func _rebuild_world() -> void:
	_clear_world()
	var width := int(state.get("width", 1))
	var height := int(state.get("height", 1))
	_box(world_root, Vector3(0, -0.62, 0), Vector3(width + 0.2, 0.75, height + 0.2), Color("10231a"))
	for raw_tile: Variant in state.get("tiles", []):
		if not raw_tile is Dictionary: continue
		var tile: Dictionary = raw_tile
		var terrain := str(tile.get("terrain", "plain"))
		var position := _world_position(tile)
		_box(world_root, position - Vector3(0, 0.05, 0), Vector3(0.98, 0.10, 0.98), TERRAIN_COLORS.get(terrain, TERRAIN_COLORS.plain))
		var resource: Variant = tile.get("resource")
		if resource is Dictionary and int(resource.get("amount", 0)) > 0 and terrain != "water":
			var kind := str(resource.get("kind", ""))
			if kind == "wood":
				_box(world_root, position + Vector3(0, 0.36, 0), Vector3(0.13, 0.72, 0.13), Color("59401f"))
				_sphere(world_root, position + Vector3(0, 0.93, 0), 0.38, Color("2c823f"))
			elif kind == "stone": _sphere(world_root, position + Vector3(0, 0.24, 0), 0.30, Color("8e9691"))
			elif kind == "food": _sphere(world_root, position + Vector3(0, 0.18, 0), 0.18, Color("e1a93e"))
	orbit_distance = maxf(float(width), float(height)) * 1.12

func _faction_color(faction_id: String) -> Color:
	for raw: Variant in state.get("factions", []):
		if raw is Dictionary and str(raw.get("id", "")) == faction_id: return Color(str(raw.get("color", "#c8ff66")))
	return Color("c8ff66")

func _sync_structures() -> void:
	var active_ids: Dictionary = {}
	for raw: Variant in state.get("structures", []):
		if not raw is Dictionary: continue
		var structure: Dictionary = raw
		var id := str(structure.get("id", "")); active_ids[id] = true
		var node: Node3D = structure_nodes.get(id)
		if node == null:
			node = Node3D.new(); node.name = "Structure_%s" % id; world_root.add_child(node); structure_nodes[id] = node
			_box(node, Vector3(0, 0.48, 0), Vector3(0.78, 0.96, 0.78), STRUCTURE_COLORS.get(str(structure.get("type", "camp")), Color("88765c")))
			_box(node, Vector3(0, 1.02, 0), Vector3(0.90, 0.12, 0.90), _faction_color(str(structure.get("factionId", ""))))
		node.position = _world_position(structure.get("position", {}))
		var ratio := 1.0 if str(structure.get("status", "")) == "active" else clampf(float(structure.get("progress", 0)) / maxf(1.0, float(structure.get("requiredProgress", 1))), 0.15, 1.0)
		node.scale.y = ratio
	for id: String in structure_nodes.keys():
		if not active_ids.has(id): structure_nodes[id].queue_free(); structure_nodes.erase(id)

func _sync_agents() -> void:
	var active_ids: Dictionary = {}
	for raw: Variant in state.get("agents", []):
		if not raw is Dictionary: continue
		var agent: Dictionary = raw
		var id := str(agent.get("id", "")); active_ids[id] = true
		var node: Node3D = agent_nodes.get(id)
		if node == null:
			node = Node3D.new(); node.name = "Agent_%s" % id; world_root.add_child(node); agent_nodes[id] = node
			_box(node, Vector3(0, 0.36, 0), Vector3(0.34, 0.72, 0.31), _faction_color(str(agent.get("factionId", ""))))
			_sphere(node, Vector3(0, 0.88, 0), 0.15, Color("d8caa8"))
		var target := _world_position(agent.get("position", {}), 0.02)
		var tween := create_tween(); tween.set_trans(Tween.TRANS_SINE); tween.set_ease(Tween.EASE_OUT); tween.tween_property(node, "position", target, 0.7)
		node.scale = Vector3.ONE * (1.22 if id == selected_agent_id else 1.0)
	for id: String in agent_nodes.keys():
		if not active_ids.has(id): agent_nodes[id].queue_free(); agent_nodes.erase(id)

func _selected_agent() -> Dictionary:
	for raw: Variant in state.get("agents", []):
		if raw is Dictionary and str(raw.get("id", "")) == selected_agent_id: return raw
	return {}

func _refresh_details() -> void:
	var lines: Array[String] = ["[color=#c8ff66][font_size=18]REGION[/font_size][/color]", "tick  %s" % state.get("tick", "-"), "bots  %s" % state.get("agents", []).size(), "buildings  %s" % state.get("structures", []).size(), ""]
	var agent := _selected_agent()
	if not agent.is_empty():
		var inventory: Dictionary = agent.get("inventory", {})
		var position: Dictionary = agent.get("position", {})
		lines.append("[color=#c8ff66][font_size=18]SELECTED[/font_size][/color]")
		lines.append("[b]%s[/b] · %s" % [agent.get("name", "?"), agent.get("role", "?")])
		lines.append("%s / %s" % [agent.get("factionId", "?"), agent.get("status", "idle")])
		lines.append("position %s,%s · HP %s" % [position.get("x", "?"), position.get("y", "?"), agent.get("hp", "?")])
		lines.append("wood %s · stone %s · food %s" % [inventory.get("wood", 0), inventory.get("stone", 0), inventory.get("food", 0)])
		lines.append("goal: %s" % agent.get("goal", ""))
	lines.append("")
	lines.append("[color=#c8ff66][font_size=18]WORLD FEED[/font_size][/color]")
	var events: Array = state.get("events", [])
	for index in range(events.size() - 1, maxi(-1, events.size() - 11), -1):
		var event: Variant = events[index]
		if event is Dictionary: lines.append("[color=#82968a]T%s[/color] %s" % [event.get("tick", "?"), event.get("message", "")])
	details.text = "\n".join(lines)

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP and event.pressed: orbit_distance *= 0.9
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN and event.pressed: orbit_distance *= 1.1
		elif event.button_index == MOUSE_BUTTON_LEFT:
			if event.pressed:
				dragging = true; drag_moved = false; drag_origin = event.position; last_mouse = event.position
			else:
				dragging = false
				if not drag_moved: _select_at(event.position)
		elif event.button_index == MOUSE_BUTTON_RIGHT and event.pressed: _move_at(event.position)
	elif event is InputEventMouseMotion and dragging:
		if event.position.distance_to(drag_origin) > 4.0: drag_moved = true
		if drag_moved:
			var delta := event.position - last_mouse
			orbit_yaw -= delta.x * 0.008; orbit_pitch = clampf(orbit_pitch + delta.y * 0.006, 0.18, 1.28)
		last_mouse = event.position
	elif event is InputEventKey and event.pressed:
		var amount := maxf(0.5, orbit_distance * 0.025)
		if event.keycode == KEY_W: orbit_target.z -= amount
		elif event.keycode == KEY_S: orbit_target.z += amount
		elif event.keycode == KEY_A: orbit_target.x -= amount
		elif event.keycode == KEY_D: orbit_target.x += amount

func _grid_from_screen(screen: Vector2) -> Vector2i:
	var origin := camera.project_ray_origin(screen)
	var direction := camera.project_ray_normal(screen)
	if absf(direction.y) < 0.0001: return Vector2i(-1, -1)
	var distance := -origin.y / direction.y
	if distance <= 0: return Vector2i(-1, -1)
	var hit := origin + direction * distance
	return Vector2i(floori(hit.x + float(state.get("width", 0)) / 2.0), floori(hit.z + float(state.get("height", 0)) / 2.0))

func _select_at(screen: Vector2) -> void:
	var grid := _grid_from_screen(screen)
	for raw: Variant in state.get("agents", []):
		if raw is Dictionary:
			var position: Dictionary = raw.get("position", {})
			if Vector2i(int(position.get("x", -9)), int(position.get("y", -9))) == grid:
				selected_agent_id = str(raw.get("id", "")); _sync_agents(); _refresh_details(); return

func _move_at(screen: Vector2) -> void:
	if selected_agent_id.is_empty(): return
	var grid := _grid_from_screen(screen)
	var tile := _tile_at(grid.x, grid.y)
	if tile.is_empty() or str(tile.get("terrain", "water")) == "water": return
	_post_json("/api/agents/%s/commands" % selected_agent_id.uri_encode(), {"id": "godot-%s" % Time.get_ticks_usec(), "type": "move", "target": {"x": grid.x, "y": grid.y}})

func _toggle_pause() -> void:
	_post_json("/api/admin/resume" if paused else "/api/admin/pause", {})

func _post_json(path: String, body: Dictionary) -> void:
	var request := HTTPRequest.new(); add_child(request)
	request.request_completed.connect(func(_result: int, code: int, _headers_value: PackedStringArray, response_body: PackedByteArray) -> void:
		if code >= 200 and code < 300:
			var parsed: Variant = JSON.parse_string(response_body.get_string_from_utf8())
			if parsed is Dictionary and parsed.has("paused"): paused = bool(parsed.get("paused", false))
		else: status_label.text = "COMMAND FAILED · HTTP %s" % code
		request.queue_free()
	)
	var error := request.request(_api_url(path), _headers(true), HTTPClient.METHOD_POST, JSON.stringify(body))
	if error != OK: request.queue_free()
