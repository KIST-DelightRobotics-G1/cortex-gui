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
      cur: -1, say: "", obs: "", obsTone: "info", reply: null, stepT0: 0,
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
        vm.mode = "failed"; vm.obs = ev.title; vm.obsTone = "fail"; return;
      case "GROUND": vm.obs = ev.title; vm.obsTone = "info"; return;
      case "CANCEL":
        vm.thinking = false; vm.obs = ev.title;
        vm.obsTone = vm.mode === "failed" ? "fail" : "stop";
        if (vm.mode !== "failed") vm.mode = "stopped";
        if (vm.steps[vm.cur] && vm.steps[vm.cur].status === "run") vm.steps[vm.cur].status = "failed";
        return;
      case "PLAN_DONE": vm.mode = "done"; vm.say = "완료"; vm.obs = ""; vm.obsTone = "info"; return;
      case "NOTE":
        if (ev.index < 0) {                    // 계획 단계가 끝났는데 계획이 없다
          vm.thinking = false; vm.mode = "blocked";
          vm.say = ev.title; vm.obs = ""; vm.obsTone = "block";
        } else { vm.obs = ev.title; vm.obsTone = "info"; }
        return;
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
  // 계획 줄은 제자리에서 고친다. 매번 다시 만들면 새 줄이 올 때마다 기존
  // 줄까지 fadein 을 다시 시작해 목록 전체가 끊겨 보이고, 갓 만든 요소라
  // transition 도 걸리지 않아 단계가 커질 때 툭 바뀐다.
  var spinePlan = null, liByIdx = Object.create(null), thinkLi = null;
  var foldTop = null, foldBot = null;

  // 1920x1080 에 들어가는 줄은 7개(실행 중 한 줄이 9.4rem, 나머지 5.25rem).
  // 그보다 길면 5줄 창 + 접힘 표시 두 줄로 바꾼다 — 창 위치는 실행 중인 단계를
  // 따라가고, 아직 실행 전이면 막 도착한 줄을 따라간다.
  var FITS = 7, WIN = 5, LEAD = 2;
  var OUT_MS = 400;                     // style.css .st.out 과 길이를 맞춘다

  // 줄은 바로 떼지 않는다. 흐려진 뒤에 뗀다 — 보이는 채로 사라지면 아래 줄이 튄다.
  function dropRow(li) {
    if (!li || li.dataset.out) return;
    li.dataset.out = "1";
    li.classList.add("out");
    setTimeout(function () { li.remove(); }, OUT_MS);
  }

  function spineWindow(n) {
    if (n <= FITS) return [0, n - 1];
    var anchor = vm.cur >= 0 ? vm.cur : n - 1;
    var start = Math.min(Math.max(anchor - LEAD, 0), n - WIN);
    return [start, start + WIN - 1];
  }

  function newRow() {
    var li = document.createElement("li");
    li.dot = document.createElement("div"); li.dot.className = "dot";
    li.tx = document.createElement("div"); li.tx.className = "tx";
    li.appendChild(li.dot); li.appendChild(li.tx);
    return li;
  }

  // 접힘 한 줄. 필요 없으면 지운다. 반환값이 곧 다음 호출의 상태다.
  function syncFold(node, show, text, before) {
    if (!show) { dropRow(node); return null; }
    if (!node) {
      node = newRow();
      node.className = "st fold";
      node.dot.textContent = "\u22ef";
      el.steps.insertBefore(node, before);
    }
    if (node.tx.textContent !== text) node.tx.textContent = text;
    return node;
  }

  function syncSteps() {
    if (vm.planId !== spinePlan) {          // 새 계획 = 이전 계획을 흐리며 뗀다
      Array.prototype.forEach.call(el.steps.children, dropRow);
      liByIdx = Object.create(null);
      thinkLi = foldTop = foldBot = null;
      spinePlan = vm.planId;
    }
    var n = vm.steps.length;
    var w = spineWindow(n), lo = w[0], hi = w[1];

    Object.keys(liByIdx).forEach(function (k) {   // 창 밖으로 나간 줄은 뗀다
      var i = +k;
      if (i < lo || i > hi) { dropRow(liByIdx[i]); delete liByIdx[i]; }
    });

    foldTop = syncFold(foldTop, lo > 0, "이전 " + lo + "단계", el.steps.firstChild);

    vm.steps.forEach(function (s) {
      if (!s || s.index < lo || s.index > hi) return;
      var li = liByIdx[s.index];
      if (!li) {                            // 새로 들어온 줄만 fadein 한다
        li = newRow();
        liByIdx[s.index] = li;
        var at = foldBot || thinkLi;        // 순서 유지 (늦게 온 줄도 제자리에)
        for (var j = s.index + 1; j <= hi; j++) {
          if (liByIdx[j]) { at = liByIdx[j]; break; }
        }
        el.steps.insertBefore(li, at);
      }
      var cls = "st " + s.status;
      if (li.className !== cls) li.className = cls;   // 여기서 transition 이 돈다
      var mark = s.status === "done" ? "\u2713" : s.status === "failed" ? "\u2715"
                                                 : String(s.index + 1);
      if (li.dot.textContent !== mark) li.dot.textContent = mark;
      if (li.tx.textContent !== s.title) li.tx.textContent = s.title;
    });

    var rest = vm.count >= 0 ? vm.count - 1 - hi : n - 1 - hi;
    foldBot = syncFold(foldBot, rest > 0, "이후 " + rest + "단계", thinkLi);

    if (vm.thinking && !thinkLi) {
      thinkLi = newRow();
      thinkLi.className = "st think";
      thinkLi.dot.textContent = "\u00b7";
      thinkLi.tx.textContent = "생각하는 중\u2026";
      el.steps.appendChild(thinkLi);
    } else if (!vm.thinking && thinkLi) {
      dropRow(thinkLi); thinkLi = null;
    }
  }
  function render() {
    var key = JSON.stringify(vm);
    if (key === lastKey) return;
    lastKey = key;

    el.wrap.dataset.mode = vm.mode;
    el.heard.textContent = vm.heard || "듣고 있습니다";
    el.heard.classList.toggle("quote", !!vm.heard);

    // plan spine
    syncSteps();
    el.planLab.textContent = vm.count >= 0 ? "Plan · " + vm.count : vm.thinking ? "Plan" : vm.steps.length ? "Plan" : "";
    el.planLab.hidden = !vm.steps.length && !vm.thinking && !vm.reply;

    // reply bubble replaces the plan
    if (vm.reply) {
      el.reply.hidden = false; el.reply.dataset.kind = vm.reply.kind; el.reply.textContent = vm.reply.say;
    } else { el.reply.hidden = true; }

    // now
    el.say.textContent = vm.say || "대기 중";
    el.obs.hidden = !vm.obs; el.obs.lastElementChild.textContent = vm.obs;
    el.obs.dataset.tone = vm.obsTone;
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
