# Deep Diagnosis of the Click Workflow Capture Bug in autodoc

## Bottom line

I do **not** think this is one simple bug. I think the current system is caught between **three competing designs** that show up clearly in the commit history:

- an older **pre-capture cache** design,
- a later **fresh screenshot on each click** design,
- and the current **continuous frame-loop plus click-time matching** design. citeturn17view1turn18view0turn33view2turn33view3

Your current implementation in `app/capture.js` does **not** really capture “the exact screen at the instant of the click.” It captures from a **buffered frame history** and will even accept a frame whose grab **started after the click** if it started within a 300 ms “slack” window. That behavior is not accidental; it is explicitly encoded in the current code and in the tests. So the “too early / too late / some clicks share the wrong background / some clicks feel missed” behavior is, in large part, a consequence of the present architecture rather than a single typo. citeturn46view0turn12view0turn13view0

The highest-confidence diagnosis is this:

1. **The current click-capture path is sample-based, not event-exact.**  
   Clicks are matched against a 200 ms frame loop and a recent-frame buffer, not a true click-synchronous desktop frame. That is why it can be early, late, or reuse the same frame for multiple fast clicks. citeturn44view0turn45view0turn46view0turn13view0

2. **The codebase intentionally accepts “close enough” post-click frames.**  
   `frameForClick()` accepts frames that start up to 300 ms after the click, because the code assumes UI reactions are often slower than that. That assumption is exactly what breaks your Folge-like requirement when the UI updates fast. citeturn44view0turn46view0turn12view0

3. **On Linux/X11, the marker position path is still weaker than the Windows path.**  
   Windows carries hook-time `x y button timestamp` data into `onOsClick()`. The current Linux path does **not** carry event coordinates into `onOsClick()`; it falls back to `screen.getCursorScreenPoint()` at parse time, which can drift if delivery is delayed or the pointer moves after the click. citeturn47view0turn28search1turn29search0

4. **The code already contains evidence that the main-process capture loop is under performance stress.**  
   The current code explicitly says a zero-gap loop starved the main-process event loop, delayed click delivery “by whole seconds,” and forced the loop to back off to a 200 ms idle gap. It also had to stop PNG-encoding every buffered frame because that caused additional starvation. That is a strong sign that the present Electron-thumbnail loop is near the limit of what it can reliably do for Folge-style “capture every fast click perfectly.” citeturn44view0turn33view3turn47view0

My recommendation is:

- If you want the **best possible fix inside the current architecture**, you can improve it substantially.
- If you want **Folge-like reliability for very fast click sequences**, you should treat that as an **architecture change**, not a patch. citeturn26search0turn47view0turn28search0

## What the current code is doing

The repo-root `capture.js` is not the real implementation. It is only a shim that re-exports `./app/capture`, so the actual behavior lives almost entirely in `app/capture.js`. citeturn41view0

In the current branch, a capture session starts **paused**. `startSession()` sets `paused: true`, and the renderer paths that start a session from the welcome screen or from a guide call the `start` action only; the red capture bar’s **Start recording** button is what sends `resume`, which then hides the window after a short delay and starts the frame loop. That means: if the window disappears immediately upon merely starting a session, that is inconsistent with current `main` and suggests either an older binary, a stale packaged build, or a path outside the current branch that still auto-resumes. citeturn44view0turn25view0turn36view0turn21view1turn16view0

The click-recording path now works like this:

`Start recording` → `togglePause(false)` → hide app window after ~400 ms → start `startFrameLoop()` → keep a rolling buffer of recently grabbed full-screen frames → when a click arrives, call `frameForClick(clickPos, clickAt)` → select the “best” frame from the buffer or wait for the next loop frame → create the step from that frame. citeturn45view0turn46view0

That is the key point: **the click does not normally trigger its own desktop capture**. The click is usually matched to an already-buffered frame, or to the next loop frame, and only falls back to `shoot()` if no usable frame is available. citeturn45view0

The current code explicitly defines these timing assumptions:

- `FRAME_LOOP_IDLE_MS = 200`
- `CLICK_FRAME_MAX_AGE_MS = 600`
- `CLICK_FRAME_WAIT_MS = 2000`
- `CLICK_FRAME_START_SLACK_MS = 300`
- `CLICK_DEBOUNCE_MS = 40` citeturn44view0

The most important logic lives in `frameForClick()`. It prefers a buffered frame completed before the click, but when it cannot find one, it is allowed to use a frame whose grab **started within 300 ms after the click**. That is a deliberate tradeoff written directly into the code comments and logic. citeturn46view0

Even more importantly, the test suite codifies that behavior. One test explicitly says an “idle click capture waits for the imminent loop frame” and accepts a frame whose `startedAt` is **100 ms after the click**. Another test explicitly says **two rapid clicks during an in-flight grab should both become steps from the same loop frame**. Those tests match your symptoms and, in my view, also prove that the current behavior is not a bug from the code’s perspective; it is the designed compromise. citeturn12view0turn13view0

## Why your symptoms are happening

### The screenshot can be too early

The system often uses a frame that was already in the rolling buffer. If the loop is running every 200 ms, then the “best” pre-click frame may still be noticeably older than the actual click, especially when the UI is changing quickly. The code allows frames up to 600 ms old to qualify if they were completed before the click. That is an eternity for UI automation or for fast workflows. citeturn44view0turn46view0

This is the direct consequence of choosing a frame-loop architecture to avoid click-time capture latency. The comments around the frame loop state that a fresh grab started after the click would land “hundreds of ms late,” so the code intentionally uses a pre-grabbed frame instead. That helps avoid post-click screenshots, but it also means the screenshot can be visibly early. citeturn45view0

### The screenshot can be too late

The code **also** allows the opposite failure mode. If no buffered frame qualifies, `frameForClick()` can wait for the next frame and accept it if the grab started within 300 ms after the click. That is a direct mechanism for “too late” screenshots, especially for apps that respond faster than the code assumes. citeturn46view0turn12view0

This is why your current “caching” approach feels like it is technically taking the screenshot *before* or *around* the click instead of *at* the click: the current code is doing temporal approximation, not event-exact correlation. citeturn45view0turn46view0

### Some fast clicks can share the wrong frame

This is, to me, the single biggest mismatch with your requirement.

Your desired behavior is: **one click → one screenshot corresponding to that click**.

The current tests explicitly approve: **two rapid clicks → two steps from the same in-flight frame**. If the first click changes the interface before the second click lands, the second step can absolutely show the wrong background even though the queue preserves click order and marker position. The queue preserves metadata, but it does not guarantee a unique frame per click. citeturn13view0

So if you click through a fast workflow, you can get:

- correct order,
- the right circled spot for each click,
- but the **same background image reused for multiple clicks**, or a background from just before or after the actual interaction. citeturn13view0turn45view0

That is not an implementation accident. It is the present design.

### Some clicks can feel “not registered”

There are three plausible causes here, all visible in the code.

First, the code still uses a **debounce** of 40 ms per button. That is much better than the old 700 ms debounce from earlier commits, but it is still a lossy policy. If your requirement is literally “I want to be able to click as many times as I want, how fast as I want,” then any debounce-based dedupe is at least philosophically at odds with that requirement. citeturn44view0turn15view1

Second, the code itself documents that the app previously starved the main-process event loop badly enough that click events arrived very late, which led to the current 200 ms idle gap and deferred PNG encoding. That means click delivery reliability is already known to be sensitive to load in this design. citeturn44view0turn33view3turn47view0

Third, on Linux the click watcher is still text-parsing `xinput test-xi2 --root`. The current Linux parser extracts the button detail and then calls `onOsClick(Date.now(), null, button)`, which causes `onOsClick()` to fall back to `screen.getCursorScreenPoint()` instead of using true event coordinates. That makes Linux especially vulnerable to cursor drift if event delivery is delayed or buffered. By contrast, the Windows path carries coordinates, button, and timestamp directly from a low-level hook. citeturn47view0

### The marker can be offset from the real click

On Windows, the code is relatively strong here. The low-level hook emits `CLICK x y button unixMs`, the parser keeps the `osPoint`, and `onOsClick()` converts physical coordinates to DIP using `screen.screenToDipPoint()`, which is exactly what Electron expects when bridging between physical screen coordinates and DIP coordinates. citeturn47view0turn28search1turn29search0

On Linux, however, the current path does **not** pass event coordinates into `onOsClick()` at all. It falls back to `screen.getCursorScreenPoint()`, which returns the current cursor position in DIP points, not the cursor position at the exact hardware event time. If the pointer moves even slightly after the click, the annotation can drift. citeturn47view0turn29search0

This is especially telling because an earlier commit **did** parse `root: x/y` from the Linux watcher stream and push those coordinates through normalization. That path is visible in the history, but it is not what is running now. In other words, there appears to have been a regression away from true event coordinates on Linux. citeturn31view0

## What I would change

### The minimal patch path

If you want the best chance of a successful fix **without rewriting the whole subsystem**, I would make these changes first.

#### Restore real event coordinates on Linux

Bring back Linux coordinate capture from the watcher output. The old history shows a version that parsed `root: X/Y` lines from `xinput test-xi2 --root` and passed them through coordinate normalization. The current Linux code no longer does that and instead falls back to the live cursor position. That is a step backward for marker accuracy. citeturn31view0turn47view0

At minimum, the Linux watcher should produce:

- button name,
- event-time coordinates,
- and ideally an event timestamp.

Then `onOsClick()` should use those event values the same way the Windows hook does. citeturn47view0

#### Remove post-click frame acceptance for strict click capture

If the product requirement is “the screenshot should be taken as it is clicked,” then you should **not** accept frames that started after the click in the default click-recording mode. That means the current `startedNearClick` logic should be removed or hidden behind a non-default “balanced” mode. citeturn46view0

Concretely, I would introduce a “strict click timing” mode where `frameForClick()` only accepts:

- frames with `capturedAt <= clickAt`, or
- an in-flight frame whose `startedAt <= clickAt`.

I would **not** accept `startedAt <= clickTime + 300` in that mode. That is exactly the heuristic that is producing late screenshots now. citeturn46view0turn12view0

#### Stop encoding the “same frame for multiple clicks” behavior as a success condition

Right now your tests lock in behavior that conflicts with your user requirement. The test suite currently approves two rapid clicks sharing one loop frame. If you want Folge-like semantics, that test should be replaced with a stricter expectation. citeturn13view0

I would rewrite the tests so that in strict mode:

- a click must never be represented by a frame whose `startedAt > clickAt`,
- Linux paths must preserve watcher coordinates,
- and two clicks must not silently reuse the same frame when that would violate the click-time semantics you want. citeturn13view0turn47view0

#### Rethink debounce

The current 40 ms per-button debounce is understandable as a guard against duplicate watcher events, but it is still a drop policy. If you truly want high-speed click workflows, replace temporal debounce with **event-source dedupe**, meaning:

- on Windows, trust one low-level button-down event as one click,
- on Linux, dedupe based on the event block / event type / serial you parse from XI2 output,
- not based on elapsed milliseconds alone. citeturn44view0turn47view0

That will reduce the odds of legitimate fast clicks disappearing.

### The architecture path I would actually recommend

If your actual requirement is:

> “I want Folge-like behavior: click, exact screenshot, exact marker, every time, very fast, as many clicks as I want.”

then I do **not** think the current main-process `desktopCapturer.getSources()` loop is the right long-term architecture. That is my strongest engineering opinion after reading the code and history. It is an inference, but a high-confidence one grounded in this codebase’s own comments and tests. citeturn47view0turn44view0turn33view3turn28search0turn26search0

Why:

- the code already had to back off from continuous capture because it starved the event loop,
- the code already had to stop PNG-encoding loop frames because it blocked too much,
- and the current tests already accept approximate timing and shared frames for rapid clicks. citeturn44view0turn47view0turn12view0turn13view0

The robust architecture is:

- **capture frames in a dedicated worker or native helper**, not the main process,
- maintain a **timestamped ring buffer** of raw frames,
- record **click-time coordinates and timestamps** from a proper hook,
- and on click choose the **latest frame whose capture completed at or before the click**.

That is how you get genuine “what the screen looked like at click time” behavior. The current code is trying to simulate that with a buffered thumbnail loop, but it is still approximation. citeturn45view0turn46view0turn47view0

If you stay inside Electron only, you can still improve the architecture by moving the grab loop out of the main process and keeping a tighter ring buffer, but if you want real product-grade reliability under rapid clicking, a platform-native streaming capture backend is the direction I would expect to win on Windows, macOS, and Linux. That is especially true because Electron’s `desktopCapturer.getSources()` is a heavy thumbnail-oriented API, not a purpose-built low-latency event-correlated recorder. citeturn28search0turn47view0

## Concrete implementation plan

### Changes I would make first in `app/capture.js`

I would make the following patch set, in this order.

#### Reintroduce Linux event coordinates

Update the Linux branch of `processClickWatcherData()` so it reconstructs an event object instead of only a button number. Keep parsing the `detail:` line to filter wheel buttons, but also parse the associated `root:` line and carry that point into `onOsClick()`. The older history already showed this direction. citeturn31view0turn47view0

I would store a pending Linux event object like:

```js
this.clickWatcherPendingEvent = {
  type: 'RawButtonPress',
  button: null,
  osPoint: null,
  at: monotonicOrDateNow
};
```

Then fill it as lines arrive, and only fire when you have enough data.

The practical goal is simple: **Linux should feed `onOsClick(at, osPoint, button)` the same way Windows already does.** citeturn47view0

#### Add a strict click-capture mode

Inside `frameForClick()`, add a mode flag, for example:

```js
const strictClickFrames = this.settings.get('capture.strictClickFrames') !== false;
```

Then change the matching logic:

- in strict mode, only accept frames with `capturedAt <= clickAt`,
- or possibly in-flight frames with `startedAt <= clickAt`,
- never accept `startedAt > clickAt`.

That means removing or bypassing:

```js
const startedNearClick = startedAt <= clickTime + CLICK_FRAME_START_SLACK_MS;
...
: allowInFlight && startedNearClick;
```

for strict click sessions. citeturn46view0

#### Change the click tests to match your real requirement

The current tests are validating behavior you no longer want. Replace them.

Specifically, rewrite the tests that currently approve:

- a post-click-started frame for an idle click,
- and two rapid clicks sharing one in-flight frame. citeturn12view0turn13view0

New tests should enforce:

- no accepted frame with `startedAt > clickAt` in strict mode,
- Linux watcher coordinates reach `onOsClick()`,
- per-button fast clicking does not get dropped by temporal debounce,
- and rapid click bursts preserve one-step-per-click semantics without silently using a post-click frame.

#### Make debounce source-aware, not purely time-aware

On Windows, a low-level hook button-down is already a unique event. Do not suppress it just because another same-button click happened within 40 ms unless you can prove duplication. On Linux, dedupe should key off duplicated textual XI2 representations, not elapsed time alone. citeturn47view0turn44view0

This does not guarantee perfect behavior by itself, but it reduces “phantom dropped clicks.”

### The files I would tell the agent to touch

The real implementation work is in:

- `app/capture.js`  
- `tests/unit/capture.test.js`  

I would also inspect and possibly adjust:

- `app/main.js` for any session wiring assumptions,
- `app/renderer/app.js` and `app/renderer/editor.js` if you want the UI wording to match the new strict-mode semantics. citeturn21view1turn25view0turn36view0

The repo-root `capture.js` is just a re-export and should not need a behavior change. citeturn41view0

## Prompt package for Claude Code or Codex

### Main implementation prompt

```text
You are editing the repo’s screen-capture subsystem.

Goal:
Fix click-based workflow recording so it behaves much closer to Folge:
- one click should create one step,
- the click marker should land on the real click location,
- the chosen screenshot should correspond to the screen at click time as closely as possible,
- rapid clicks should not be silently dropped,
- strict mode must never use a frame whose capture started after the click.

Important background from the current codebase:
- capture.js at the repo root is just a re-export; the real logic is in app/capture.js.
- Current click capture is built around a frame loop and frameForClick().
- The current implementation intentionally accepts post-click-started frames within a slack window and currently allows multiple rapid clicks to reuse the same in-flight frame. That behavior must be changed for strict click capture.
- Current Linux click handling is weaker than Windows: Linux often falls back to screen.getCursorScreenPoint() instead of carrying watcher-time event coordinates into onOsClick().
- The test suite currently encodes some of the behavior we do not want; update it.

What to do:
1. In app/capture.js, audit the Linux xinput watcher path in processClickWatcherData().
   - Reintroduce parsing of watcher-provided click coordinates (for example from “root: x/y” lines if available from xinput test-xi2 --root).
   - Carry Linux click coordinates into onOsClick(at, osPoint, button) instead of falling back to screen.getCursorScreenPoint() whenever possible.
   - If possible, also preserve an event time rather than only Date.now() at parse time.

2. Add a strict click-capture mode in app/capture.js.
   - Use a setting like capture.strictClickFrames (default true unless there is a reason not to).
   - In strict mode, frameForClick() may only accept:
     a) frames with capturedAt <= clickAt, or
     b) optionally an in-flight frame with startedAt <= clickAt.
   - In strict mode, do NOT accept a frame whose startedAt > clickAt.
   - Remove or bypass the current startedNearClick / CLICK_FRAME_START_SLACK_MS behavior for strict mode.

3. Revisit debounce.
   - Replace purely time-based dropping of same-button clicks with source-aware dedupe where possible.
   - On Windows, do not drop legitimate hook events just because they happen within 40 ms.
   - On Linux, dedupe actual duplicate watcher events, not legitimate fast clicks.

4. Update tests in tests/unit/capture.test.js.
   - Add a Linux watcher test that verifies event coordinates are parsed and forwarded.
   - Add a strict-mode test proving that a frame started after the click is rejected.
   - Add a burst-click test proving rapid clicks are preserved one-for-one.
   - Remove or rewrite tests that encode the old “same in-flight frame is okay for multiple clicks” behavior if strict mode is enabled.

5. Keep backward compatibility where reasonable.
   - If you need a non-strict fallback mode for slower platforms, keep it behind an explicit setting.
   - Default behavior for workflow recording should favor click accuracy over throughput.

6. Add clear comments in app/capture.js explaining:
   - why strict click mode rejects post-click-started frames,
   - why Linux watcher coordinates must be preserved,
   - and why debounce must be event-aware.

Deliverables:
- the code changes,
- updated tests,
- a short summary of exactly what changed and why,
- and any platform caveats that remain.
```

### Validation prompt

```text
Re-read app/capture.js and tests/unit/capture.test.js and verify all of the following:

- Root capture.js is still only a re-export.
- Starting a session from the UI still begins paused until “Start recording” / resume is pressed.
- In strict click mode, no stored step can come from a frame with startedAt > clickAt.
- Linux click parsing preserves watcher coordinates into onOsClick().
- Rapid click bursts are not silently dropped by the old debounce behavior.
- Tests cover Windows hook coordinates/timestamps, Linux coordinates, and strict frame selection.
- If any existing test depended on reuse of the same in-flight frame for multiple clicks, that behavior has either been removed in strict mode or clearly isolated behind a non-strict mode.
```

### If you want the agent to pursue the bigger redesign

```text
The current frame-loop design is still approximate. Propose and implement a second-stage architecture plan for Folge-like reliability:

- move continuous screen capture off the main process,
- keep a timestamped ring buffer of raw frames,
- correlate click hook timestamps and coordinates with that buffer,
- choose the latest frame captured at or before the click,
- and preserve one unique screenshot selection per click.

Do not immediately overbuild a full native backend unless necessary, but produce:
1. a concrete design,
2. a minimal refactor plan,
3. and a phased implementation path that can start from the existing app/capture.js code.
```

## Open questions and confidence

I am highly confident that the **core diagnosis** is correct: the current code is using an approximation strategy that intentionally trades exact click-time capture for responsiveness, and that tradeoff is the main reason you are seeing early/late/shared-frame behavior. The code and tests are unusually explicit about that. citeturn45view0turn46view0turn12view0turn13view0

I am also highly confident that the repo-root `capture.js` is irrelevant to the bug, and that `app/capture.js` plus `tests/unit/capture.test.js` are the real places to fix it. citeturn41view0turn11view0

The main limitation is that I did **not** run the app locally, and you did not provide the actual screenshot or your runtime platform. So I cannot say with certainty whether your marker-offset issue is happening on Windows, Linux/X11, WSLg, or Wayland. That matters because the Windows and Linux watcher paths are materially different. The current code itself acknowledges platform differences, especially around Linux/Wayland/WSLg. citeturn44view0turn42view1turn28search1turn29search0

One last important note: if you are seeing the window hide **immediately when a session is started from a guide**, that does **not** match the current `main` branch behavior, which is explicitly paused-first. In that specific case, I would suspect you are running an older packaged build or a branch that predates the paused-start fix. The commit history shows that this behavior was changed explicitly on June 11, 2026. citeturn16view0turn25view0turn36view0turn44view0

My practical recommendation is:

- do the **minimal patch** first if you need a quick improvement,
- but if this feature is central to the product, plan for the **architecture rewrite** rather than expecting one more timing tweak to get you all the way to Folge-level reliability. citeturn26search0turn44view0turn47view0