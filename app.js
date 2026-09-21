// KIST G1 display renderer — thought flow. Vanilla, buildless, ROS-free.
//
// WebSocket input (cortex gui_bridge_node, SYS-REQ-41):
//   text  {"scenario","subtask":{name,i,n}|null,"state"}       legacy status (still honoured)
//   text  {"type":"event","t","plan_id","kind","index","title","body"}   thought-flow event
//   binary                                                        latest camera JPEG
//
// Events are folded into one view-model (reduce) and the DOM is patched from it.
// The status message only fills gaps (idle / count) — events carry the story.

(function () {
  "use strict";

  var WS_URL =
    (window.GUI_CONFIG && window.GUI_CONFIG.wsUrl) ||
    "ws://" + (location.hostname || "localhost") + ":8081";

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    wrap: $("wrap"), heard: $("heard"), planLab: $("planLab"), steps: $("steps"), reply: $("reply"),
    say: $("say"), obs: $("obs"), bar: $("bar"), stepNo: $("stepNo"), elapsed: $("elapsed"),
    cam: $("cam"), view: $("view"), live: $("live"),
  };
  var ctx = el.view.getContext("2d");

  // ---- view-model ----
  var vm = fresh();
  function fresh() {
    return {
      mode: "idle",          // idle | planning | running | reply | done | failed | stopped
      planId: "", heard: "", thinking: false, count: -1,
      steps: [],             // [{index, title, status: pending|run|done|failed}]
      cur: -1, say: "", obs: "", reply: null, stepT0: 0,
    };
  }

  function reduce(ev) {
    var k = ev.kind, i = ev.index;
    switch (k) {
      case "HEARD":
        if (ev.body === "stop") { vm.obs = "“" + ev.title + "”"; return; }
        vm = fresh();
        vm.mode = "planning"; vm.planId = ev.plan_id; vm.heard = ev.title; vm.thinking = true;
        vm.say = "생각하는 중"; vm.stepT0 = performance.now();
        return;
      case "THINKING": vm.thinking = true; return;
      case "PLAN_LINE":
        if (ev.plan_id !== vm.planId) { vm = fresh(); vm.planId = ev.plan_id; vm.mode = "planning"; }
        vm.steps[i] = { index: i, title: ev.title, status: "pending" };
        return;
      case "PLAN_END": vm.thinking = false; vm.count = i; return;
      case "REPLY":
        vm.thinking = false; vm.mode = "reply"; vm.reply = { kind: ev.body, say: ev.title };
        vm.say = ev.title; return;
      case "STEP_START":
        vm.mode = "running"; vm.cur = i; vm.say = ev.title; vm.obs = ""; vm.stepT0 = performance.now();
        if (vm.steps[i]) vm.steps[i].status = "run";
        return;
      case "STEP_DONE": if (vm.steps[i]) vm.steps[i].status = "done"; return;
      case "STEP_FAILED":
        if (vm.steps[i]) vm.steps[i].status = "failed";
        vm.mode = "failed"; vm.obs = ev.title; return;
      case "GROUND": vm.obs = ev.title; return;
      case "CANCEL":
        vm.thinking = false; vm.obs = ev.title;
        if (vm.mode !== "failed") vm.mode = "stopped";
        if (vm.steps[vm.cur] && vm.steps[vm.cur].status === "run") vm.steps[vm.cur].status = "failed";
        return;
      case "PLAN_DONE": vm.mode = "done"; vm.say = "완료"; vm.obs = ""; return;
      case "NOTE": vm.obs = ev.title; return;
    }
  }

  // Legacy status: only used to fall back to idle when no plan is active.
  function applyStatus(s) {
    if (s.state === "idle" && (vm.mode === "done" || vm.mode === "failed" || vm.mode === "stopped")) {
      // keep the finished plan on screen; nothing to do
    }
    if (s.state === "idle" && vm.mode === "idle") render();
  }

  // ---- DOM ----
  var lastKey = "";
  function render() {
    var key = JSON.stringify(vm);
    if (key === lastKey) return;
    lastKey = key;

    el.wrap.dataset.mode = vm.mode;
    el.heard.textContent = vm.heard || "듣고 있습니다";
    el.heard.classList.toggle("quote", !!vm.heard);

    // plan spine
    var frag = document.createDocumentFragment();
    vm.steps.forEach(function (s) {
      if (!s) return;
      var li = document.createElement("li");
      li.className = "st " + s.status;
      var dot = document.createElement("div"); dot.className = "dot";
      dot.textContent = s.status === "done" ? "✓" : s.status === "failed" ? "✕" : String(s.index + 1);
      var tx = document.createElement("div"); tx.className = "tx"; tx.textContent = s.title;
      li.appendChild(dot); li.appendChild(tx); frag.appendChild(li);
    });
    if (vm.thinking) {
      var li = document.createElement("li"); li.className = "st think";
      li.innerHTML = '<div class="dot">·</div><div class="tx">생각하는 중…</div>';
      frag.appendChild(li);
    }
    el.steps.replaceChildren(frag);
    el.planLab.textContent = vm.count >= 0 ? "Plan · " + vm.count : vm.thinking ? "Plan" : vm.steps.length ? "Plan" : "";
    el.planLab.hidden = !vm.steps.length && !vm.thinking && !vm.reply;

    // reply bubble replaces the plan
    if (vm.reply) {
      el.reply.hidden = false; el.reply.dataset.kind = vm.reply.kind; el.reply.textContent = vm.reply.say;
    } else { el.reply.hidden = true; }

    // now
    el.say.textContent = vm.say || "대기 중";
    el.obs.hidden = !vm.obs; el.obs.lastElementChild.textContent = vm.obs;
    var n = vm.count >= 0 ? vm.count : vm.steps.length;
    var done = vm.steps.filter(function (s) { return s && s.status === "done"; }).length;
    el.bar.style.width = n ? Math.round((done / n) * 100) + "%" : "0";
    el.stepNo.textContent = vm.cur >= 0 && n ? "STEP " + (vm.cur + 1) + " / " + n : "";
  }

  function tickClock() {
    var show = vm.mode === "running" || vm.mode === "planning";
    el.elapsed.textContent = show ? ((performance.now() - vm.stepT0) / 1000).toFixed(1) + " s" : "";
  }

  // ---- camera ----
  var latestFrame = null, hasFrame = false;
  function drawFrame() {
    if (!latestFrame) return;
    var box = el.view.parentElement;
    var dpr = window.devicePixelRatio || 1;
    var W = box.clientWidth, H = box.clientHeight;
    if (el.view.width !== Math.floor(W * dpr)) { el.view.width = Math.floor(W * dpr); el.view.height = Math.floor(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var s = Math.max(W / latestFrame.width, H / latestFrame.height);
    var dw = latestFrame.width * s, dh = latestFrame.height * s;
    ctx.drawImage(latestFrame, (W - dw) / 2, (H - dh) / 2, dw, dh);
    if (!hasFrame) { hasFrame = true; el.cam.classList.add("has-frame"); }
  }

  // ---- websocket ----
  var backoff = 500;
  function setConn(state, label) { el.live.dataset.conn = state; el.live.lastElementChild.textContent = label; }
  function connect() {
    var ws;
    try { ws = new WebSocket(WS_URL); } catch (e) { scheduleReconnect(); return; }
    ws.binaryType = "blob";
    ws.onopen = function () { setConn("connected", "LIVE"); backoff = 500; };
    ws.onmessage = function (e) {
      if (typeof e.data === "string") {
        var m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m && m.type === "event") { reduce(m); render(); }
        else if (m) applyStatus(m);
      } else {
        createImageBitmap(e.data).then(function (bmp) {
          if (latestFrame && latestFrame.close) latestFrame.close();
          latestFrame = bmp; drawFrame();
        }).catch(function () {});
      }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () { setConn("reconnecting", "RECONNECTING"); scheduleReconnect(); };
  }
  function scheduleReconnect() { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 5000); }
  connect();

  // Click / tap toggles fullscreen (needs a user gesture; use kiosk mode for the wall).
  document.body.addEventListener("click", function () {
    if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); }
    else { var r = document.documentElement.requestFullscreen; if (r) r.call(document.documentElement); }
  });
  window.addEventListener("resize", drawFrame);
  setInterval(tickClock, 100);
  render();
})();
