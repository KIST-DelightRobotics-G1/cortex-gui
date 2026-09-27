"""Local dev mock of cortex gui_bridge_node (SYS-REQ-41).

Replays a scripted "thought flow" — the same event stream the orchestrator
emits on /cortex/trace — plus a legacy status JSON and a small JPEG, so the
renderer can be developed and demoed WITHOUT cortex or the robot. ROS-free.

Timings of the planning phase come from the 3rd measurement round
(gemini-3.6-flash: first line 1.4 s, plan complete ~1.9 s). Step durations are
made up (nav 6 s, VLA 3 s).

Run:
    pip install websockets pillow      # pillow optional
    python tools/mock_publisher.py [--scenario cucumber|reply|fail|stop|blocked|long] [--loop]
Then:
    python3 -m http.server 8080        # in the repo root
    # browser: http://localhost:8080/?ws=ws://localhost:8081
"""

import argparse
import asyncio
import io
import json
import math
import time

import websockets

_clients = set()
_status = {"scenario": "", "subtask": None, "state": "idle"}
_history = []          # events of the current plan, replayed to late clients


def _make_jpeg(i: int) -> bytes:
    try:
        from PIL import Image, ImageDraw

        img = Image.new("RGB", (640, 360), (36, 38, 42))
        d = ImageDraw.Draw(img)
        d.rectangle([420, 60, 540, 300], fill=(180, 184, 190))            # fridge
        d.rectangle([80, 240, 300, 250], fill=(120, 105, 90))             # table
        x = int(190 + 10 * math.sin(i / 10.0))
        d.rounded_rectangle([x - 20, 232, x + 20, 240], radius=4, fill=(80, 140, 60))
        d.text((12, 12), f"mock frame {i}", fill=(160, 160, 160))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70)
        return buf.getvalue()
    except Exception:
        return b"\xff\xd8\xff\xe0mock\xff\xd9"


# ---------------------------------------------------------------------------
# Scripts: (delay_before_s, kind, index, title, body)
# ---------------------------------------------------------------------------
PLAN = [
    (0, "HEARD", -1, "냉장고에서 오이 가져와줘", ""),
    (0.1, "THINKING", -1, "생각하는 중", "idle"),
    (1.3, "PLAN_LINE", 0, "냉장고로 이동", ""),
    (0.05, "STEP_START", 0, "냉장고로 갑니다", ""),
    (0.15, "PLAN_LINE", 1, "냉장고 문 열기", ""),
    (0.15, "PLAN_LINE", 2, "오이 집기", ""),
    (0.15, "PLAN_LINE", 3, "냉장고 문 닫기", ""),
    (0.15, "PLAN_LINE", 4, "사용자에게 이동", ""),
    (0.15, "PLAN_LINE", 5, "오이 건네기", ""),
    (0.05, "PLAN_END", 6, "계획 6단계", ""),
]
TITLES = ["냉장고로 이동", "냉장고 문 열기", "오이 집기", "냉장고 문 닫기", "사용자에게 이동", "오이 건네기"]
SAYS = ["냉장고로 갑니다", "냉장고 문을 엽니다", "오이를 집습니다", "냉장고 문을 닫습니다",
        "사용자에게 갑니다", "오이를 건네드립니다"]
GROUND = [None, "냉장고 문 확인됨", "오이 확인됨", "냉장고 문 확인됨", None, "사용자 확인됨"]
DUR = [6.0, 3.0, 3.0, 3.0, 6.0, 3.0]          # nav 6 s, vla 3 s (made up)


def script_cucumber(fail_at=None, stop_at=None):
    ev = list(PLAN)
    for i in range(6):
        if i > 0:
            ev.append((DUR[i - 1], "STEP_DONE", i - 1, TITLES[i - 1], ""))
            if stop_at == i:
                ev.append((0.6, "HEARD", -1, "그만", "stop"))
                ev.append((0.1, "CANCEL", i - 1, "중단", "user"))
                return ev
            if GROUND[i]:
                ev.append((0.1, "GROUND", i, GROUND[i], ""))
            if fail_at == i:
                ev.append((0.1, "STEP_START", i, SAYS[i], ""))
                ev.append((3.0, "STEP_FAILED", i, TITLES[i] + " 실패", "timeout"))
                ev.append((0.1, "CANCEL", -1, "계획 중단", "step failed"))
                return ev
            ev.append((0.1, "STEP_START", i, SAYS[i], ""))
    ev.append((DUR[5], "STEP_DONE", 5, TITLES[5], ""))
    ev.append((0.2, "PLAN_DONE", -1, "완료", ""))
    return ev


def script_long():
    """10단계. 계획 줄이 7개를 넘으면 실행 중인 단계 둘레만 남고 접힌다."""
    titles = ["냉장고로 이동", "냉장고 문 열기", "오이 꺼내기", "우유 꺼내기",
              "냉장고 문 닫기", "조리대로 이동", "오이 내려놓기", "우유 내려놓기",
              "사용자에게 이동", "다 됐다고 알리기"]
    says = ["냉장고로 갑니다", "냉장고 문을 엽니다", "오이를 꺼냅니다", "우유를 꺼냅니다",
            "냉장고 문을 닫습니다", "조리대로 갑니다", "오이를 내려놓습니다",
            "우유를 내려놓습니다", "사용자에게 갑니다", "다 됐다고 알립니다"]
    ev = [(0, "HEARD", -1, "냉장고에서 오이랑 우유 꺼내서 조리대에 놔줘", ""),
          (0.1, "THINKING", -1, "생각하는 중", "idle")]
    ev.append((1.3, "PLAN_LINE", 0, titles[0], ""))
    ev.append((0.05, "STEP_START", 0, says[0], ""))
    for i in range(1, 10):
        ev.append((0.2, "PLAN_LINE", i, titles[i], ""))
    ev.append((0.05, "PLAN_END", 10, "계획 10단계", ""))
    for i in range(1, 10):
        ev.append((2.5, "STEP_DONE", i - 1, titles[i - 1], ""))
        ev.append((0.1, "STEP_START", i, says[i], ""))
    ev.append((2.5, "STEP_DONE", 9, titles[9], ""))
    ev.append((0.2, "PLAN_DONE", -1, "완료", ""))
    return ev


SCRIPTS = {
    "cucumber": lambda: script_cucumber(),
    "fail": lambda: script_cucumber(fail_at=1),
    "stop": lambda: script_cucumber(stop_at=2),
    "long": script_long,
    # 검증기가 막은 경우. cortex 는 막은 이유를 그대로 말하고 화면에도 같은 문장을 보낸다
    # (executor.py 의 _error_say). 계획은 한 줄도 나오지 않는다.
    "blocked": lambda: [
        (0, "HEARD", -1, "화장실로 가", ""),
        (0.1, "THINKING", -1, "생각하는 중", "idle"),
        (1.6, "NOTE", -1, "그곳은 아직 갈 수 없습니다.", "unknown_place|bathroom"),
    ],
    "reply": lambda: [
        (0, "HEARD", -1, "오리 가져다줘", ""),
        (0.1, "THINKING", -1, "생각하는 중", "idle"),
        (1.2, "REPLY", -1, "오이 말씀이신가요?", "confirm"),
        (4.0, "HEARD", -1, "응", ""),
        (0.1, "THINKING", -1, "생각하는 중", "awaiting_confirm"),
    ] + script_cucumber()[2:],
}


async def _broadcast(text=None, data=None):
    for ws in list(_clients):
        try:
            if text is not None:
                await ws.send(text)
            if data is not None:
                await ws.send(data)
        except Exception:
            _clients.discard(ws)


async def _handler(ws):
    try:
        await ws.send(json.dumps(_status, ensure_ascii=False))
        for e in _history:
            await ws.send(e)
    except Exception:
        return
    _clients.add(ws)
    print(f"client connected ({len(_clients)})")
    try:
        async for _ in ws:
            pass
    finally:
        _clients.discard(ws)


async def _frames():
    i = 0
    while True:
        i += 1
        await _broadcast(data=_make_jpeg(i))
        await asyncio.sleep(1 / 15)


async def _events(script_name: str, loop: bool, delay: float):
    plan_seq = 0
    await asyncio.sleep(delay)
    while True:
        plan_seq += 1
        pid = f"p-mock-{plan_seq:04d}"
        _history.clear()
        for delay, kind, index, title, body in SCRIPTS[script_name]():
            await asyncio.sleep(delay)
            ev = json.dumps({"type": "event", "t": time.time(), "plan_id": pid, "kind": kind,
                             "index": index, "title": title, "body": body}, ensure_ascii=False)
            if kind == "HEARD" and body != "stop":
                _history.clear()
            _history.append(ev)
            _status.update(scenario=title if kind == "HEARD" else _status["scenario"],
                           state="active" if kind == "STEP_START" else _status["state"])
            await _broadcast(text=ev)
            print(f"{kind:11s} {index:2d} {title}")
        _status.update(state="idle")
        await _broadcast(text=json.dumps(_status, ensure_ascii=False))
        if not loop:
            print("script finished; keeping the socket open (Ctrl-C to quit)")
            await asyncio.Event().wait()
        await asyncio.sleep(6)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=sorted(SCRIPTS), default="cucumber")
    ap.add_argument("--loop", action="store_true", help="replay forever")
    ap.add_argument("--port", type=int, default=8081)
    ap.add_argument("--delay", type=float, default=3.0, help="seconds before the first event (open the page first)")
    a = ap.parse_args()
    async with websockets.serve(_handler, "0.0.0.0", a.port):
        print(f"mock publisher on ws://0.0.0.0:{a.port}  scenario={a.scenario}")
        await asyncio.gather(_frames(), _events(a.scenario, a.loop, a.delay))


if __name__ == "__main__":
    asyncio.run(main())
