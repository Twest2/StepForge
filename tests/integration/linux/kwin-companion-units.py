#!/usr/bin/python3
"""Checks the Plasma helper's input decoding, device discovery and monitor
geometry with recorded kernel events. Needs python3-gobject only; no desktop."""
import os
import struct
import sys

# The repository's helper, or the installed one (STEPFORGE_HELPER_DIR).
sys.path.insert(0, os.environ.get('STEPFORGE_HELPER_DIR')
                or os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../app/platform/linux'))
import kwin_companion as kc  # noqa: E402

EV = struct.Struct('llHHi')


def events(*rows):
    """rows: (ms, type, code, value) -> packed input_event records."""
    return b''.join(EV.pack(int(ms // 1000), int(ms % 1000 * 1000), kind, code, value)
                    for ms, kind, code, value in rows)


def syn(ms):
    return (ms, kc.EV_SYN, kc.SYN_REPORT, 0)


def touch(start, end, fingers=1, moves=(), tool=kc.BTN_TOOL_FINGER):
    """A touchpad contact from start to end ms, at (500, 500) unless moved."""
    rows = [(start, kc.EV_ABS, kc.ABS_X, 500), (start, kc.EV_ABS, kc.ABS_Y, 500),
            (start, kc.EV_KEY, kc.BTN_TOUCH, 1), (start, kc.EV_KEY, tool, 1), syn(start)]
    for ms, x, y in moves:
        rows += [(ms, kc.EV_ABS, kc.ABS_X, x), (ms, kc.EV_ABS, kc.ABS_Y, y), syn(ms)]
    rows += [(end, kc.EV_KEY, kc.BTN_TOUCH, 0), (end, kc.EV_KEY, tool, 0), syn(end)]
    return rows


failures = []


def check(name, actual, expected):
    if actual != expected:
        failures.append(f'{name}: expected {expected!r}, got {actual!r}')
    else:
        print(f'ok - {name}')


# Mouse buttons, split across reads exactly as a device can deliver them.
mouse = kc.ButtonReader()
data = events((1000.5, kc.EV_KEY, kc.BTN_LEFT, 1), syn(1000.5), (1080, kc.EV_KEY, kc.BTN_LEFT, 0), syn(1080),
              (2000, kc.EV_KEY, kc.BTN_RIGHT, 1), syn(2000), (2100, kc.EV_KEY, kc.BTN_MIDDLE, 1), syn(2100),
              (2200, kc.EV_KEY, kc.BTN_MIDDLE, 2))  # autorepeat is not a press
check('mouse presses, never releases or repeats',
      mouse.feed(data[:30]) + mouse.feed(data[30:]), [(1, 1000.5), (3, 2000), (2, 2100)])
check('left-handed mouse swaps left and right',
      kc.ButtonReader(left_handed=True).feed(events((5, kc.EV_KEY, kc.BTN_LEFT, 1), (6, kc.EV_KEY, kc.BTN_RIGHT, 1))),
      [(3, 5), (1, 6)])

# Touchpad taps: libinput's default 180 ms and 1.3 mm, with finger counts.
pad = dict(touchpad=True, tap=True, units_per_mm=(40, 40))
check('one-finger tap is a left click at lift-off', kc.ButtonReader(**pad).feed(events(*touch(100, 220))), [(1, 220)])
check('two-finger tap is a right click',
      kc.ButtonReader(**pad).feed(events(*touch(100, 200, tool=kc.BTN_TOOL_DOUBLETAP))), [(3, 200)])
check('three-finger tap is a middle click',
      kc.ButtonReader(**pad).feed(events(*touch(100, 200, tool=kc.BTN_TOOL_TRIPLETAP))), [(2, 200)])
check('left-middle-right map swaps two and three fingers',
      kc.ButtonReader(lmr=True, **pad).feed(events(*touch(100, 200, tool=kc.BTN_TOOL_DOUBLETAP))), [(2, 200)])
check('a long touch is not a tap', kc.ButtonReader(**pad).feed(events(*touch(100, 400))), [])
check('moving the finger is not a tap',
      kc.ButtonReader(**pad).feed(events(*touch(100, 200, moves=[(150, 600, 500)]))), [])
check('small jitter is still a tap',
      kc.ButtonReader(**pad).feed(events(*touch(100, 200, moves=[(150, 540, 520)]))), [(1, 200)])
check('taps are ignored when Plasma has tap-to-click off',
      kc.ButtonReader(touchpad=True, tap=False).feed(events(*touch(100, 200))), [])
pressed = touch(100, 200)
pressed.insert(4, (100, kc.EV_KEY, kc.BTN_LEFT, 1))
check('pressing the touchpad down is one click, not a click and a tap',
      kc.ButtonReader(**pad).feed(events(*pressed)), [(1, 100)])
clickfinger = touch(100, 300, tool=kc.BTN_TOOL_DOUBLETAP)
clickfinger.insert(5, (150, kc.EV_KEY, kc.BTN_LEFT, 1))
check('two-finger press with clickfinger is a right click',
      kc.ButtonReader(clickfinger=True, **pad).feed(events(*clickfinger)), [(3, 150)])

# Only readable mice and touchpads are opened; keyboards never are.
table = '''I: Bus=0003 Vendor=046d Product=c52b
N: Name="Logitech USB Receiver"
H: Handlers=sysrq kbd event3 leds

I: Bus=0003 Vendor=046d Product=c077
N: Name="Logitech USB Optical Mouse"
H: Handlers=mouse0 event5

I: Bus=0018 Vendor=06cb Product=7e7e
N: Name="SYNA2BA6:00 06CB:CEAB Touchpad"
H: Handlers=event9 mouse1

I: Bus=0003 Vendor=1234 Product=0001
N: Name="Unreadable Mouse"
H: Handlers=mouse2 event11
'''
check('pointer devices from /proc/bus/input/devices',
      kc.pointer_devices(table, readable=lambda path, _mode: path != '/dev/input/event11'),
      [('/dev/input/event5', 'event5'), ('/dev/input/event9', 'event9')])

# KWin's logical geometry wins over a portal that reports pixels.
screens = [{'name': 'eDP-1', 'x': 0, 'y': 0, 'width': 1440, 'height': 900},
           {'name': 'DP-2', 'x': 1440, 'y': 0, 'width': 1920, 'height': 1080}]
check('portal pixels become KWin logical geometry',
      kc.normalize_bounds({'x': 0, 'y': 0, 'width': 2880, 'height': 1800}, screens),
      {'x': 0, 'y': 0, 'width': 1440, 'height': 900})
check('logical portal geometry is kept',
      kc.normalize_bounds({'x': 1440, 'y': 0, 'width': 1920, 'height': 1080}, screens),
      {'x': 1440, 'y': 0, 'width': 1920, 'height': 1080})
check('an unknown monitor keeps the portal geometry',
      kc.normalize_bounds({'x': 5000, 'y': 0, 'width': 800, 'height': 600}, screens),
      {'x': 5000, 'y': 0, 'width': 800, 'height': 600})

# A stalled KWin cannot grow the helper's queue forever, and stop releases
# every outstanding callback and timer without waiting for a D-Bus timeout.
import collections
companion = object.__new__(kc.KWinCompanion)
companion.closed = False
companion.waiting = {}
companion.request_timers = {}
companion.queue = collections.deque()
companion.next_id = 1
companion.poll = None
errors = []
for _ in range(kc.MAX_REQUESTS + 1):
    companion.request({}, lambda _value: None, errors.append)
check('KWin queue is bounded', len(companion.waiting), kc.MAX_REQUESTS)
check('excess request fails', len(errors), 1)
for timer in companion.request_timers.values():
    kc.GLib.source_remove(timer)
companion.waiting.clear()
companion.request_timers.clear()
companion.queue.clear()
old_timeout = kc.REQUEST_TIMEOUT_MS
kc.REQUEST_TIMEOUT_MS = 1
companion.request({}, lambda _value: None, errors.append)
deadline = kc.time.monotonic() + 1
while companion.waiting and kc.time.monotonic() < deadline:
    kc.GLib.MainContext.default().iteration(False)
check('unanswered KWin request expires', len(companion.waiting), 0)
check('expired request leaves no queued work', len(companion.queue), 0)
check('expiry calls failure callback', len(errors), 2)
kc.REQUEST_TIMEOUT_MS = old_timeout

if failures:
    print('\n'.join(failures), file=sys.stderr)
    sys.exit(1)
print('kwin-companion units passed')
