-- bridge.lua — mGBA 0.10.x <-> Bridge Server (NDJSON over TCP)
--
-- Lua 侧只做"字节读写 + 按键执行 + 存档点"，不做任何解析。
-- 加载方式：mGBA -> Tools -> Scripting -> File -> Load script...
-- 协议：每行一个 JSON；请求 {"id":1,"cmd":"read",...}，响应 {"id":1,"ok":true,...}。
--
-- 命令：hello / ping / read / write / press / wait / save_state / load_state / screenshot / reset_keys

local PORT = 8765
local HOST = "127.0.0.1"
local PROTOCOL_VERSION = 1

-- ---------------------------------------------------------------------------
-- 重复加载：先清掉上一次留下的 server / 回调 / 按键
-- ---------------------------------------------------------------------------
if rawget(_G, "PBA") and PBA.cleanup then
	pcall(PBA.cleanup)
end
PBA = { clients = {}, callbacks = {}, queue = {}, current = nil, nextClientId = 1 }
local S = PBA

local function log(msg) console:log("[bridge] " .. msg) end
local function logerr(msg) console:error("[bridge] " .. msg) end

-- ---------------------------------------------------------------------------
-- 极简 JSON（够用即可）
-- ---------------------------------------------------------------------------
local json = {}

local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function encodeString(s)
	return '"' .. s:gsub('[%c"\\]', function(c)
		return escapes[c] or string.format("\\u%04x", c:byte())
	end) .. '"'
end

local function isArray(t)
	local n = 0
	for _ in pairs(t) do n = n + 1 end
	if n == 0 then return true end
	for i = 1, n do
		if t[i] == nil then return false end
	end
	return true
end

function json.encode(v)
	local ty = type(v)
	if ty == "nil" then return "null" end
	if ty == "boolean" then return v and "true" or "false" end
	if ty == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return "null" end
		if math.type(v) == "integer" or v == math.floor(v) then return string.format("%d", v) end
		return string.format("%.14g", v)
	end
	if ty == "string" then return encodeString(v) end
	if ty == "table" then
		local parts = {}
		if isArray(v) then
			for i = 1, #v do parts[i] = json.encode(v[i]) end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		for k, val in pairs(v) do
			parts[#parts + 1] = encodeString(tostring(k)) .. ":" .. json.encode(val)
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	error("cannot encode " .. ty)
end

local function skipWs(s, i)
	return s:find("[^ \t\r\n]", i) or (#s + 1)
end

local decodeValue

local function decodeString(s, i)
	-- s:sub(i,i) == '"'
	local out, j = {}, i + 1
	while true do
		local c = s:sub(j, j)
		if c == "" then error("unterminated string") end
		if c == '"' then return table.concat(out), j + 1 end
		if c == "\\" then
			local e = s:sub(j + 1, j + 1)
			if e == "u" then
				local cp = tonumber(s:sub(j + 2, j + 5), 16)
				if not cp then error("bad \\u escape") end
				out[#out + 1] = utf8.char(cp)
				j = j + 6
			else
				local map = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
				if not map[e] then error("bad escape \\" .. e) end
				out[#out + 1] = map[e]
				j = j + 2
			end
		else
			out[#out + 1] = c
			j = j + 1
		end
	end
end

decodeValue = function(s, i)
	i = skipWs(s, i)
	local c = s:sub(i, i)
	if c == "{" then
		local obj = {}
		i = skipWs(s, i + 1)
		if s:sub(i, i) == "}" then return obj, i + 1 end
		while true do
			i = skipWs(s, i)
			if s:sub(i, i) ~= '"' then error("object key expected at " .. i) end
			local key
			key, i = decodeString(s, i)
			i = skipWs(s, i)
			if s:sub(i, i) ~= ":" then error("':' expected at " .. i) end
			local val
			val, i = decodeValue(s, i + 1)
			obj[key] = val
			i = skipWs(s, i)
			local d = s:sub(i, i)
			if d == "}" then return obj, i + 1 end
			if d ~= "," then error("',' or '}' expected at " .. i) end
			i = i + 1
		end
	elseif c == "[" then
		local arr = {}
		i = skipWs(s, i + 1)
		if s:sub(i, i) == "]" then return arr, i + 1 end
		while true do
			local val
			val, i = decodeValue(s, i)
			arr[#arr + 1] = val
			i = skipWs(s, i)
			local d = s:sub(i, i)
			if d == "]" then return arr, i + 1 end
			if d ~= "," then error("',' or ']' expected at " .. i) end
			i = i + 1
		end
	elseif c == '"' then
		return decodeString(s, i)
	elseif s:sub(i, i + 3) == "true" then
		return true, i + 4
	elseif s:sub(i, i + 4) == "false" then
		return false, i + 5
	elseif s:sub(i, i + 3) == "null" then
		return nil, i + 4
	else
		local num = s:match("^-?%d+%.?%d*[eE]?[+-]?%d*", i)
		if not num or num == "" then error("unexpected token at " .. i) end
		return tonumber(num), i + #num
	end
end

function json.decode(s)
	local v, i = decodeValue(s, 1)
	i = skipWs(s, i)
	if i <= #s then error("trailing garbage at " .. i) end
	return v
end

-- ---------------------------------------------------------------------------
-- hex 工具
-- ---------------------------------------------------------------------------
local function toHex(bin)
	local out, n = {}, #bin
	for i = 1, n, 512 do
		local chunk = { bin:byte(i, math.min(i + 511, n)) }
		out[#out + 1] = string.rep("%02x", #chunk):format(table.unpack(chunk))
	end
	return table.concat(out)
end

local function fromHex(hex)
	if #hex % 2 ~= 0 or hex:find("[^0-9a-fA-F]") then error("invalid hex") end
	local bytes = {}
	for i = 1, #hex, 2 do bytes[#bytes + 1] = tonumber(hex:sub(i, i + 1), 16) end
	return bytes
end

-- ---------------------------------------------------------------------------
-- 按键
-- ---------------------------------------------------------------------------
local KEY_NAMES = { "A", "B", "SELECT", "START", "RIGHT", "LEFT", "UP", "DOWN", "R", "L" }
local ALL_KEYS_MASK = 0x3FF

local function keyMask(keys)
	local mask = 0
	for _, name in ipairs(keys or {}) do
		local idx = C.GBA_KEY[name]
		if idx == nil or idx < 0 then error("unknown key: " .. tostring(name)) end
		mask = mask | (1 << idx)
	end
	return mask
end

-- ---------------------------------------------------------------------------
-- 客户端 I/O
-- ---------------------------------------------------------------------------
local function flush(client)
	if not client.out or #client.out == 0 then return end
	local sock = client.sock
	while #client.out > 0 do
		local last, err = sock:send(client.out)
		if not last then
			if err ~= socket.ERRORS.AGAIN then S.dropClient(client.id, "send error: " .. tostring(err)) end
			return
		end
		if last <= 0 then return end
		client.out = client.out:sub(last + 1)
	end
end

local function sendTo(client, tbl)
	local ok, line = pcall(json.encode, tbl)
	if not ok then
		line = json.encode({ id = tbl.id, ok = false, error = "encode failed: " .. tostring(line) })
	end
	client.out = (client.out or "") .. line .. "\n"
	flush(client)
end

local function reply(client, id, tbl)
	tbl.id = id
	if tbl.ok == nil then tbl.ok = true end
	sendTo(client, tbl)
end

local function replyError(client, id, msg)
	sendTo(client, { id = id, ok = false, error = tostring(msg) })
end

-- ---------------------------------------------------------------------------
-- 命令实现
-- ---------------------------------------------------------------------------
local handlers = {}

local function romCrc32()
	local raw = emu:checksum(C.CHECKSUM.CRC32)
	if not raw or #raw < 4 then return nil, nil end
	local b1, b2, b3, b4 = raw:byte(1, 4)
	-- 实测（mGBA 0.10.5 / macOS）：返回的是大端 4 字节，"1f1c08fb" 即 0x1F1C08FB
	local v = (b1 << 24) | (b2 << 16) | (b3 << 8) | b4
	return string.format("%08X", v), toHex(raw:sub(1, 4))
end

handlers.hello = function(client, id)
	local crc, rawHex = romCrc32()
	local titleOk, title = pcall(function() return emu:getGameTitle() end)
	reply(client, id, {
		protocol = PROTOCOL_VERSION,
		game_code = emu:getGameCode(),
		game_title = titleOk and title or nil,
		rom_crc32 = crc,
		rom_crc32_raw_hex = rawHex,
		frame = emu:currentFrame(),
	})
end

handlers.ping = function(client, id)
	reply(client, id, { frame = emu:currentFrame() })
end

handlers.read = function(client, id, req)
	local out = {}
	for i, r in ipairs(req.ranges or {}) do
		local addr, len = r.addr, r.len
		if type(addr) ~= "number" or type(len) ~= "number" or len < 0 or len > 0x10000 then
			return replyError(client, id, "bad range #" .. i)
		end
		out[i] = toHex(emu:readRange(addr, len))
	end
	reply(client, id, { data = out, frame = emu:currentFrame() })
end

handlers.write = function(client, id, req)
	local addr = req.addr
	if type(addr) ~= "number" or type(req.hex) ~= "string" then
		return replyError(client, id, "addr(number) and hex(string) required")
	end
	local bytes = fromHex(req.hex)
	for i, b in ipairs(bytes) do emu:write8(addr + i - 1, b) end
	reply(client, id, { written = #bytes })
end

handlers.save_state = function(client, id, req)
	local ok
	if req.path then ok = emu:saveStateFile(req.path) else ok = emu:saveStateSlot(req.slot or 1) end
	if not ok then return replyError(client, id, "save_state failed") end
	reply(client, id, {})
end

handlers.load_state = function(client, id, req)
	local ok
	if req.path then ok = emu:loadStateFile(req.path) else ok = emu:loadStateSlot(req.slot or 1) end
	if not ok then return replyError(client, id, "load_state failed") end
	emu:clearKeys(ALL_KEYS_MASK)
	reply(client, id, { frame = emu:currentFrame() })
end

handlers.screenshot = function(client, id, req)
	if type(req.path) ~= "string" then return replyError(client, id, "path required") end
	emu:screenshot(req.path)
	reply(client, id, {})
end

handlers.reset_keys = function(client, id)
	emu:clearKeys(ALL_KEYS_MASK)
	reply(client, id, {})
end

-- press / wait 进入队列，由 frame 回调逐帧推进，完成后才回复。
handlers.press = function(client, id, req)
	local steps = {}
	for i, s in ipairs(req.seq or {}) do
		local ok, mask = pcall(keyMask, s.keys)
		if not ok then return replyError(client, id, mask) end
		steps[i] = { mask = mask, hold = math.max(1, math.floor(s.hold or 4)), wait = math.max(0, math.floor(s.wait or 6)) }
	end
	S.queue[#S.queue + 1] = { client = client, id = id, steps = steps, si = 1, phase = "idle", counter = 0, startFrame = emu:currentFrame() }
end

handlers.wait = function(client, id, req)
	local frames = math.max(0, math.floor(req.frames or 0))
	S.queue[#S.queue + 1] = { client = client, id = id, steps = { { mask = 0, hold = 1, wait = math.max(0, frames - 1) } }, si = 1, phase = "idle", counter = 0, startFrame = emu:currentFrame() }
end

-- ---------------------------------------------------------------------------
-- frame 回调：推进按键队列、冲刷发送缓冲
-- ---------------------------------------------------------------------------
local function finishJob(job)
	S.current = nil
	if job.client and S.clients[job.client.id] then
		reply(job.client, job.id, { frames = emu:currentFrame() - job.startFrame, frame = emu:currentFrame() })
	end
end

local function onFrame()
	for _, c in pairs(S.clients) do flush(c) end

	local job = S.current
	if not job then
		job = table.remove(S.queue, 1)
		if not job then return end
		S.current = job
	end

	-- 发起者已经断开：直接丢弃并释放按键
	if not S.clients[job.client.id] then
		emu:clearKeys(ALL_KEYS_MASK)
		S.current = nil
		return
	end

	while true do
		local step = job.steps[job.si]
		if not step then return finishJob(job) end

		if job.phase == "idle" then
			if step.mask ~= 0 then emu:addKeys(step.mask) end
			job.phase, job.counter = "hold", step.hold
			return
		elseif job.phase == "hold" then
			job.counter = job.counter - 1
			if job.counter > 0 then return end
			if step.mask ~= 0 then emu:clearKeys(step.mask) end
			job.phase, job.counter = "wait", step.wait
			if job.counter > 0 then return end
			-- wait == 0：同帧直接进入下一步
			job.phase, job.si = "idle", job.si + 1
		elseif job.phase == "wait" then
			job.counter = job.counter - 1
			if job.counter > 0 then return end
			job.phase, job.si = "idle", job.si + 1
		end
	end
end

-- ---------------------------------------------------------------------------
-- socket server
-- ---------------------------------------------------------------------------
function S.dropClient(cid, why)
	local c = S.clients[cid]
	if not c then return end
	S.clients[cid] = nil
	pcall(function() c.sock:close() end)
	if S.current and S.current.client.id == cid then
		emu:clearKeys(ALL_KEYS_MASK)
		S.current = nil
	end
	log("client " .. cid .. " closed" .. (why and (": " .. why) or ""))
end

local function dispatch(client, line)
	local ok, req = pcall(json.decode, line)
	if not ok or type(req) ~= "table" then
		return replyError(client, nil, "bad json: " .. tostring(req))
	end
	local h = handlers[req.cmd]
	if not h then return replyError(client, req.id, "unknown cmd: " .. tostring(req.cmd)) end
	local ok2, err = pcall(h, client, req.id, req)
	if not ok2 then replyError(client, req.id, err) end
end

local function onClientData(cid)
	local client = S.clients[cid]
	if not client then return end
	while client.sock:hasdata() do
		local chunk, err = client.sock:receive(4096)
		if not chunk then
			if err ~= socket.ERRORS.AGAIN then S.dropClient(cid, tostring(err)) end
			return
		end
		client.inbuf = client.inbuf .. chunk
		if #client.inbuf > 1048576 then return S.dropClient(cid, "request too large") end
	end
	while true do
		local nl = client.inbuf:find("\n", 1, true)
		if not nl then break end
		local line = client.inbuf:sub(1, nl - 1)
		client.inbuf = client.inbuf:sub(nl + 1)
		if #line > 0 then dispatch(client, line) end
		if not S.clients[cid] then return end
	end
end

local function onAccept()
	local sock, err = S.server:accept()
	if not sock then
		logerr("accept failed: " .. tostring(err))
		return
	end
	-- 只允许一个桥接服务连接：新连接顶掉旧连接
	for cid in pairs(S.clients) do S.dropClient(cid, "replaced by new connection") end
	local cid = S.nextClientId
	S.nextClientId = cid + 1
	local client = { id = cid, sock = sock, inbuf = "", out = "" }
	S.clients[cid] = client
	sock:add("received", function() onClientData(cid) end)
	sock:add("error", function() S.dropClient(cid, "socket error") end)
	log("client " .. cid .. " connected")
end

function S.cleanup()
	for _, id in ipairs(S.callbacks) do pcall(function() callbacks:remove(id) end) end
	S.callbacks = {}
	for cid in pairs(S.clients) do S.dropClient(cid, "cleanup") end
	if S.server then pcall(function() S.server:close() end) S.server = nil end
	pcall(function() emu:clearKeys(ALL_KEYS_MASK) end)
end

local function start()
	local server, err = socket.bind(HOST, PORT)
	if not server then
		if err == socket.ERRORS.ADDRESS_IN_USE then
			logerr("port " .. PORT .. " already in use — 旧脚本还在占用？请 Scripting 窗口 File -> Reset，或重启 mGBA。")
		else
			logerr("bind failed: " .. tostring(err))
		end
		return
	end
	local _, lerr = server:listen()
	if lerr then
		logerr("listen failed: " .. tostring(lerr))
		server:close()
		return
	end
	S.server = server
	server:add("received", onAccept)
	S.callbacks[#S.callbacks + 1] = callbacks:add("frame", onFrame)
	S.callbacks[#S.callbacks + 1] = callbacks:add("shutdown", function() S.cleanup() end)
	log(string.format("listening on %s:%d (protocol %d)", HOST, PORT, PROTOCOL_VERSION))
end

start()
