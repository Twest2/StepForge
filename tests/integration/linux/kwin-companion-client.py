#!/usr/bin/python3
"""Real KWin + the real StepForge KWin script + the Plasma helper's companion.

Run only by kwin-headless.test.sh, inside a private D-Bus session with a
headless kwin_wayland. A FIFO stands in for the mouse device; everything else
(script loading, the long-poll protocol, pointer, window and app lookup, and
unloading) goes through KWin itself.
"""
import os
import struct
import sys
import tempfile
import time

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gio, GLib, Gtk  # noqa: E402

assert os.environ.get('STEPFORGE_ISOLATED_KWIN') == '1'
# The repository's helper, or the installed one (STEPFORGE_HELPER_DIR).
sys.path.insert(0, os.environ.get('STEPFORGE_HELPER_DIR')
                or os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../app/platform/linux'))
import kwin_companion as kc  # noqa: E402

APP_ID = 'org.stepforge.KWinTest'
TITLE = 'StepForge KWin integration target'
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
context = GLib.MainContext.default()


def pump(seconds, until=lambda: False):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and not until():
        context.iteration(False) or time.sleep(0.01)
    return until()


def fail(message):
    print(f'kwin-companion FAILED: {message}', file=sys.stderr)
    sys.exit(1)


# A real Wayland client for KWin to manage, with a desktop file for its name.
app = Gtk.Application(application_id=APP_ID)
windows = []
app.connect('activate', lambda a: windows.append(Gtk.ApplicationWindow(application=a, title=TITLE)) or
            (windows[-1].maximize(), windows[-1].present()))
app.register(None)
app.activate()
if not pump(20, lambda: windows and windows[0].is_active()):
    fail('the test window never became active in KWin')

fifo_dir = tempfile.mkdtemp()
fifo = os.path.join(fifo_dir, 'event99')
os.mkfifo(fifo)
events = []
companion = kc.KWinCompanion(bus, lambda name, payload: events.append((name, payload)),
                             devices=[(fifo, 'event99')])
companion.check()
print('hello', companion.hello)
if companion.hello.get('protocol') != 1:
    fail('wrong protocol from the script')
if not companion.screens or companion.screens[0]['width'] != 1280 or companion.screens[0]['height'] != 720:
    fail(f'unexpected screens {companion.screens}')
plugin_loaded = lambda: bus.call_sync(kc.KWIN, kc.SCRIPTING_PATH, kc.SCRIPTING_IFACE, 'isScriptLoaded',  # noqa: E731
    GLib.Variant('(s)', [companion.plugin]), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
if not plugin_loaded():
    fail('KWin does not list the loaded script')

# Capture window / the hotkey: the active window and its app name.
answers = []
companion.context(answers.append, lambda reason: fail(reason))
if not pump(5, lambda: answers):
    fail('no context answer from KWin')
info = answers[0]
print('context', info)
if info['windowTitle'] != TITLE or info['appId'] != APP_ID or info['appName'] != 'StepForge KWin test':
    fail(f'wrong active window {info}')
rect = info['window']
if not rect or rect['width'] < 600 or rect['height'] < 300:
    fail(f'no window geometry {rect}')
if info['windowPid'] != os.getpid():
    fail('window pid does not match this process')

# A mouse click: the press from the "device", the pointer and window from KWin.
companion.arm()
writer = os.open(fifo, os.O_WRONLY)
now = time.time()
press = struct.pack('llHHi', int(now), int(now % 1 * 1e6), kc.EV_KEY, kc.BTN_LEFT, 1)
sync = struct.pack('llHHi', int(now), int(now % 1 * 1e6), kc.EV_SYN, kc.SYN_REPORT, 0)
os.write(writer, press + sync)
if not pump(5, lambda: any(name == 'Click' for name, _ in events)):
    fail(f'no click event (events: {events})')
click = next(payload for name, payload in events if name == 'Click')
print('click', click)
if click['button'] != 1 or not all(isinstance(click[k], (int, float)) for k in ('x', 'y', 'at')):
    fail(f'malformed click {click}')
if abs(click['at'] - time.monotonic() * 1000) > 5000:
    fail('click time is not on the monotonic clock')
if not (0 <= click['x'] < 1280 and 0 <= click['y'] < 720):
    fail('pointer outside the virtual monitor')
if click['window'] != rect or click['windowTitle'] != TITLE or click['appName'] != 'StepForge KWin test':
    fail(f'the click is not on the maximized test window: {click}')

# Stop: the script is unloaded and the device released.
os.close(writer)
companion.close()
if not pump(3, lambda: not plugin_loaded()):
    fail('KWin still has the StepForge script after stop')
# A helper killed before it can clean up (a crash): the next recording
# unloads its script from KWin and deletes its file.
import signal  # noqa: E402
import subprocess  # noqa: E402
helper_dir = os.path.dirname(kc.__file__)
child = subprocess.Popen([sys.executable, '-I', '-c', f'''
import sys, time
sys.path.insert(0, {helper_dir!r})
from gi.repository import Gio
import kwin_companion as kc
c = kc.KWinCompanion(Gio.bus_get_sync(Gio.BusType.SESSION, None), lambda *a: None, devices=[("/dev/null", "x")])
c.check()
print(c.plugin, c.script_file, flush=True)
time.sleep(120)
'''], stdout=subprocess.PIPE, text=True)
stale_plugin, stale_file = child.stdout.readline().split()
child.send_signal(signal.SIGKILL)
child.wait()
if not bus.call_sync(kc.KWIN, kc.SCRIPTING_PATH, kc.SCRIPTING_IFACE, 'isScriptLoaded',
        GLib.Variant('(s)', [stale_plugin]), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]:
    fail('the killed helper\'s script should still be loaded before cleanup')
if not os.path.exists(stale_file):
    fail('the killed helper\'s script file should still exist before cleanup')
after = kc.KWinCompanion(bus, lambda *a: None, devices=[(fifo, 'event99')])
after.check()
still = bus.call_sync(kc.KWIN, kc.SCRIPTING_PATH, kc.SCRIPTING_IFACE, 'isScriptLoaded',
    GLib.Variant('(s)', [stale_plugin]), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
if still or os.path.exists(stale_file):
    fail(f'a killed helper\'s script was left behind (loaded={still}, file={os.path.exists(stale_file)})')
after.close()
leftovers = [n for n in os.listdir(os.environ['XDG_RUNTIME_DIR']) if n.startswith('stepforge-kwin-')]
if leftovers:
    fail(f'script files left after stopping: {leftovers}')
print('kwin-companion: real KWin script, context, click, unload and crash cleanup passed')
