# kist-drl-g1-gui

Browser **display renderer** for the KIST DRL Unitree-G1 demo (REQ-49 / TASK-49).

Subscribes to the cortex `gui_bridge_node` WebSocket (SYS-REQ-41) and shows
the robot's **thought flow** — what it heard, the plan the LLM is streaming,
what it is doing now — with the camera as a small reference view.
**Vanilla HTML/JS — no build step, ROS-free.**

The workstation only *publishes data*; all compositing/overlay/rendering lives
here (rendering concern split out of the workstation).

## Run

Serve the static files and open in a browser:

```bash
python3 -m http.server 8080
# open: http://localhost:8080/?ws=ws://<workstation-ip>:8081
```

Default WS URL is `ws://<page-host>:8081`; override with the `?ws=` query param.

### Local dev without the workstation

```bash
pip install websockets pillow
python3 tools/mock_publisher.py        # fake publisher on ws://localhost:8081
# then: python3 -m http.server 8080  and open  http://localhost:8080/?ws=ws://localhost:8081
```

`--scenario cucumber|reply|fail|stop|blocked|long` picks a scripted thought flow (`--loop`
repeats it, `--delay` gives you time to open the page first). Planning-phase
timings follow the 3rd measurement round (first subtask 1.4 s).

### Docker

The renderer has its own container (cortex runs in another one and serves `:8081`).

```bash
docker/build.sh                               # image: kist-cortex-gui
docker/run.sh                                 # serve on :8080, restarts after reboot
# open: http://localhost:8080/?ws=ws://<workstation-ip>:8081
docker/run.sh mock --scenario fail --loop     # fake publisher on :8081, no cortex needed
```

## WebSocket message contract

Source of truth: cortex `gui_bridge_node` (SYS-REQ-41). Three message types:

- **binary**: latest camera JPEG bytes (omitted until a frame exists)
- **text, status** (legacy, still honoured):

  ```json
  { "scenario": "냉장고에서 오이 가져와줘", "subtask": { "name": "냉장고 문 열기", "i": 1, "n": 6 }, "state": "active" }
  ```

- **text, event** — the robot's *thought flow*, one message per decision
  (`/cortex/trace` → JSON). The renderer folds these into the screen:

  ```json
  { "type": "event", "t": 1758400000.12, "plan_id": "p-1758351012-0007",
    "kind": "PLAN_LINE", "index": 1, "title": "냉장고 문 열기", "body": "" }
  ```

  | kind | screen effect |
  |---|---|
  | `HEARD` | new plan: HEARD shows the utterance, plan cleared, "생각하는 중" (body `stop` = a stop word: kept, and prefixed to the following `CANCEL` line) |
  | `THINKING` | dashed "thinking" dot at the end of PLAN |
  | `PLAN_LINE` | step `index` appears (fade-in) — arrives while the LLM streams. Over 7 steps, the spine keeps a 5-step window around the current one and folds the rest into `이전 N단계` / `이후 N단계` rows |
  | `PLAN_END` | thinking dot removed; `Plan · N` |
  | `REPLY` | bubble instead of a plan; body `chat|none|confirm` (confirm = Caution border) |
  | `STEP_START` | step becomes the large current one; NOW shows `title` (the spoken sentence) |
  | `STEP_DONE` / `STEP_FAILED` | ✓ filled / ✕ Danger. On failure NOW reads "<step> 실패" in Danger; `title` (the module's English reason) is not shown |
  | `GROUND` | line under NOW (e.g. "냉장고 문 확인됨"), grey |
  | `CANCEL` | current step marked ✕; note under NOW, hollow dot; NOW dims. After a stop word: note is `“그만” · <title>`, NOW "멈춥니다" |
  | `PLAN_DONE` | NOW "완료" |
  | `NOTE` | `index >= 0`: grey note under NOW. `index < 0` means planning ended with no plan (a blocked or failed `KIND_ERROR`): the thinking dot stops and NOW shows `title` in Caution |

  A client that connects late receives the current plan's events replayed, so a
  refreshed page recovers the flow.

Design: `Safety Node` brand palette v2 (monochrome dark tokens); hue only for a
failed step (Danger) or a confirm question (Caution). Top-left carries the lab
name (whose demo this is), bottom-left the Safety Node mark (who built it) —
separated by position and size, not colour. Sub-headings are English
(HEARD / PLAN / NOW / CAMERA); content is Korean. Layout scales with the
viewport (`1rem = 1/120 vw`), designed at 1920×1080.

## Files

| File | Role |
|------|------|
| `index.html` | DOM layout: lab name + HEARD / PLAN / NOW / CAMERA + corner marks |
| `app.js` | WS client + reconnect + event reducer + DOM patching + camera canvas |
| `config.js` | WS URL (`?ws=` override) |
| `style.css` | fullscreen layout |
| `tools/mock_publisher.py` | local dev WS publisher (no workstation needed) |

## Contributing

PRs squash-merged to `main`. CI (`.github/workflows/pr-meta.yml`) enforces:

- Branch: `TASK-{number}` (Notion-linked) or `chore/{description}`
- PR title: `([TASK-{number}] | [chore]) <type>(<scope>)?: <lowercase subject>`
