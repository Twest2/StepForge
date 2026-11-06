"""KDE Plasma 6 companion for portal_capture.py: clicks, pointer and windows.

Plasma has no equivalent of the StepForge GNOME extension, so two pieces do
its job while a recording is open:

* Mouse buttons are read from the kernel input devices. The package's udev
  rule (60-stepforge-input.rules) gives the logged-in seat access to mice and
  touchpads only, never keyboards. Touchpad taps are recognised here with
  libinput's default timing, and only when Plasma has tap-to-click turned on.
* A KWin script (kwin/stepforge-capture.js), loaded through KWin's scripting
  D-Bus API, reports where the pointer was at each click, the window under it
  and the monitor layout. KWin scripts cannot export D-Bus methods, so the
  script long-polls this helper's object for requests.

Nothing here reads keys, and every device and the script are released when
recording stops or this process dies.
"""
import collections
import fcntl
import json
import os
import re
import struct
import tempfile
import time

from gi.repository import Gio, GLib

KWIN = 'org.kde.KWin'
SCRIPTING_PATH = '/Scripting'
SCRIPTING_IFACE = 'org.kde.kwin.Scripting'
SCRIPT_IFACE = 'org.kde.kwin.Script'
INPUT_DEVICE_IFACE = 'org.kde.KWin.InputDevice'
HELPER_PATH = '/org/stepforge/KWin'
HELPER_IFACE = 'org.stepforge.KWin1'
PROTOCOL = 1
SCRIPT_SOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kwin', 'stepforge-capture.js')
HELPER_XML = f'''<node><interface name="{HELPER_IFACE}">
  <method name="Poll"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="Reply"><arg type="s" direction="in"/></method>
  <method name="Event"><arg type="s" direction="in"/></method>
</interface></node>'''
# KWin's callDBus gives up on a reply after D-Bus's default 25 s.
KEEPALIVE_S = 10
REQUEST_TIMEOUT_MS = 5000
MAX_REQUESTS = 32
# Script files written by load_script(): stepforge-kwin-<helper pid>-<random>.js
STALE_SCRIPT = re.compile(r'stepforge-kwin-(\d+)-[^/]*\.js')

NO_DEVICES = ('StepForge cannot read mouse buttons. Install the StepForge package, '
              'then unplug and replug the mouse or restart the computer.')

# ---- kernel input events ----------------------------------------------------
EVENT = struct.Struct('llHHi')  # struct input_event: timeval, type, code, value
EV_SYN, EV_KEY, EV_ABS = 0, 1, 3
SYN_REPORT = 0
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
BTN_TOOL_FINGER, BTN_TOUCH = 0x145, 0x14a
BTN_TOOL_DOUBLETAP, BTN_TOOL_TRIPLETAP, BTN_TOOL_QUADTAP = 0x14d, 0x14e, 0x14f
ABS_X, ABS_Y = 0, 1
BUTTONS = {BTN_LEFT: 1, BTN_MIDDLE: 2, BTN_RIGHT: 3}
FINGERS = {BTN_TOOL_FINGER: 1, BTN_TOOL_DOUBLETAP: 2, BTN_TOOL_TRIPLETAP: 3, BTN_TOOL_QUADTAP: 4}
# libinput's default tap timeout and motion threshold.
TAP_TIMEOUT_MS = 180
TAP_MOVE_MM = 1.3


def pointer_devices(table=None, readable=os.access):
    """Readable /dev/input/eventN nodes of mice and touchpads, as (path, sysName)."""
    if table is None:
        try:
            with open('/proc/bus/input/devices', encoding='utf-8', errors='replace') as handle:
                table = handle.read()
        except OSError:
            return []
    devices = []
    for block in table.split('\n\n'):
        handlers = next((line.split('=', 1)[1].split() for line in block.splitlines()
                         if line.startswith('H: Handlers=')), [])
        if not any(h.startswith('mouse') and h[5:].isdigit() for h in handlers):
            continue
        event = next((h for h in handlers if h.startswith('event') and h[5:].isdigit()), None)
        path = f'/dev/input/{event}' if event else None
        if path and readable(path, os.R_OK):
            devices.append((path, event))
    return devices


def event_ms(sec, usec):
    return sec * 1000 + usec / 1000


class ButtonReader:
    """Turns one device's events into button presses: [(button, realtimeMs)].

    `touchpad` enables tap recognition (one, two and three finger taps, mapped
    like libinput's default left-right-middle or Plasma's left-middle-right
    setting); `clickfinger` maps a two or three finger press like Plasma does.
    `left_handed` swaps the left and right buttons.
    """

    def __init__(self, touchpad=False, tap=False, lmr=False, clickfinger=False,
                 left_handed=False, units_per_mm=(0, 0)):
        self.touchpad = touchpad
        self.tap = touchpad and tap
        self.lmr = lmr
        self.clickfinger = touchpad and clickfinger
        self.left_handed = left_handed
        self.units = tuple(u if u > 0 else 10 for u in units_per_mm)
        self.buffer = b''
        self.fingers = 0
        self.touching = False
        self.clicked = False
        self.touch = None
        self.pos = [None, None]

    def map_button(self, button, fingers=1):
        if self.clickfinger and button == 1 and fingers in (2, 3):
            button = {2: 3, 3: 2}[fingers]
        if self.left_handed and button in (1, 3):
            button = 4 - button
        return button

    def tap_button(self, fingers):
        order = (1, 2, 3) if self.lmr else (1, 3, 2)
        return self.map_button(order[fingers - 1]) if 1 <= fingers <= 3 else None

    def feed(self, data):
        self.buffer += data
        presses = []
        size = EVENT.size
        while len(self.buffer) >= size:
            sec, usec, kind, code, value = EVENT.unpack_from(self.buffer)
            self.buffer = self.buffer[size:]
            presses.extend(self.event(kind, code, value, event_ms(sec, usec)))
        return presses

    def event(self, kind, code, value, at):
        if kind == EV_KEY and code in BUTTONS:
            if value != 1:
                return []
            self.clicked = True  # a physical click during a touch is not a tap
            return [(self.map_button(BUTTONS[code], max(self.fingers, 1)), at)]
        if not self.touchpad:
            return []
        if kind == EV_KEY and code in FINGERS:
            if value:
                self.fingers = FINGERS[code]
            elif self.fingers == FINGERS[code]:
                self.fingers = 0
        elif kind == EV_KEY and code == BTN_TOUCH:
            self.touching = bool(value)
        elif kind == EV_ABS and code in (ABS_X, ABS_Y):
            self.pos[code] = value
        elif kind == EV_SYN and code == SYN_REPORT:
            clicked, self.clicked = self.clicked, False
            return self.frame(at, clicked) if self.tap else []
        return []

    def frame(self, at, clicked):
        touch = self.touch
        if self.touching and touch is None:
            self.touch = {'at': at, 'start': list(self.pos), 'fingers': max(self.fingers, 1),
                          'moved': False, 'pressed': clicked}
            return []
        if touch is None:
            return []
        touch['pressed'] = touch['pressed'] or clicked
        if self.touching:
            touch['fingers'] = max(touch['fingers'], self.fingers)
            for axis in (0, 1):
                start, now = touch['start'][axis], self.pos[axis]
                if start is None:
                    touch['start'][axis] = now
                elif now is not None and abs(now - start) > TAP_MOVE_MM * self.units[axis]:
                    touch['moved'] = True
            return []
        self.touch = None
        if touch['moved'] or touch['pressed'] or at - touch['at'] > TAP_TIMEOUT_MS:
            return []
        button = self.tap_button(touch['fingers'])
        return [(button, at)] if button else []


def abs_resolution(fd, axis):
    """Units per mm of an absolute axis (EVIOCGABS), or 0 when unknown."""
    request = (2 << 30) | (24 << 16) | (ord('E') << 8) | (0x40 + axis)
    try:
        info = fcntl.ioctl(fd, request, bytes(24))
    except OSError:
        return 0
    return struct.unpack('6i', info)[5]


# ---- the KWin side -----------------------------------------------------------

def normalize_bounds(bounds, screens):
    """The portal reports each monitor's position and size; KWin's own logical
    geometry for the monitor at that position wins, so click coordinates and
    frames always share KWin's coordinate space."""
    for screen in screens or []:
        if screen.get('x') == bounds['x'] and screen.get('y') == bounds['y'] \
                and screen.get('width', 0) > 0 and screen.get('height', 0) > 0:
            return {'x': screen['x'], 'y': screen['y'],
                    'width': screen['width'], 'height': screen['height']}
    return bounds


class KWinCompanion:
    label = 'Plasma'

    def __init__(self, bus, on_event, devices=None, script_source=SCRIPT_SOURCE):
        self.bus = bus
        self.on_event = on_event
        self.devices = devices
        self.script_source = script_source
        self.kwin = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetNameOwner', GLib.Variant('(s)', [KWIN]),
            None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
        self.plugin = f'stepforge-capture-{os.getpid()}'
        self.script_file = None
        self.loaded = False
        self.hello = None
        self.screens = []
        self.poll = None
        self.keepalive = 0
        self.queue = collections.deque()
        self.waiting = {}
        self.request_timers = {}
        self.next_id = 1
        self.readers = []
        self.app_names = {}
        self.closed = False
        node = Gio.DBusNodeInfo.new_for_xml(HELPER_XML)
        self.registration = bus.register_object(HELPER_PATH, node.interfaces[0],
                                                self.method_call, None, None)
        self.subscriptions = [bus.signal_subscribe(None, 'org.freedesktop.ScreenSaver',
            'ActiveChanged', None, None, Gio.DBusSignalFlags.NONE, self.screensaver)]

    # -- lifecycle ------------------------------------------------------------
    def check(self):
        """Fail early, before the portal asks anything, when Plasma recording
        cannot work: no readable pointer device, or KWin does not run the script."""
        if self.devices is None:
            self.devices = pointer_devices()
        if not self.devices:
            raise RuntimeError(NO_DEVICES)
        self.load_script()

    def load_script(self):
        with open(self.script_source, encoding='utf-8') as handle:
            source = handle.read().replace('@SERVICE@', self.bus.get_unique_name())
        runtime = os.environ.get('XDG_RUNTIME_DIR') or tempfile.gettempdir()
        self.remove_stale_scripts(runtime)
        # The file name carries this helper's process id, so a later helper can
        # tell whose script it is if this one is killed before it can clean up.
        fd, self.script_file = tempfile.mkstemp(prefix=f'stepforge-kwin-{os.getpid()}-', suffix='.js', dir=runtime)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(source)
        script_id = self.kwin_call(SCRIPTING_PATH, SCRIPTING_IFACE, 'loadScript',
                                   GLib.Variant('(ss)', [self.script_file, self.plugin]))[0]
        if script_id < 0:
            raise RuntimeError('KWin did not accept the StepForge script. Plasma 6 is required.')
        self.loaded = True
        self.kwin_call(f'{SCRIPTING_PATH}/Script{script_id}', SCRIPT_IFACE, 'run', None)
        deadline = time.monotonic() + 5
        context = GLib.MainContext.default()
        while self.hello is None and time.monotonic() < deadline and not self.closed:
            context.iteration(False) or time.sleep(0.01)
        if self.hello is None:
            raise RuntimeError('KWin did not start the StepForge script. Plasma 6 is required.')
        if self.hello.get('protocol') != PROTOCOL:
            raise RuntimeError('The StepForge KWin script does not match this helper (protocol mismatch).')

    def remove_stale_scripts(self, runtime):
        """Unload and delete scripts left by helpers that were killed (a crash
        or SIGKILL skips close()). Such a script has stopped following the
        pointer, but KWin keeps it loaded until it is unloaded by name."""
        try:
            names = os.listdir(runtime)
        except OSError:
            return
        for name in names:
            match = STALE_SCRIPT.fullmatch(name)
            if not match or int(match.group(1)) == os.getpid():
                continue
            pid = int(match.group(1))
            try:
                os.kill(pid, 0)
                continue  # that recording is still running
            except ProcessLookupError:
                pass
            except PermissionError:
                continue
            try:
                self.kwin_call(SCRIPTING_PATH, SCRIPTING_IFACE, 'unloadScript',
                               GLib.Variant('(s)', [f'stepforge-capture-{pid}']))
            except GLib.Error:
                pass
            try:
                os.unlink(os.path.join(runtime, name))
            except OSError:
                pass

    def kwin_call(self, path, iface, method, args):
        result = self.bus.call_sync(KWIN, path, iface, method, args, None,
                                    Gio.DBusCallFlags.NONE, 5000, None)
        return result.unpack() if result is not None else ()

    def arm(self):
        self.disarm()
        for path, sys_name in self.devices:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
            except OSError:
                continue
            reader = self.reader_for(fd, sys_name)
            watch = GLib.io_add_watch(fd, GLib.PRIORITY_HIGH, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR,
                                      self.readable, reader)
            self.readers.append((fd, watch, reader))
        if not self.readers:
            raise RuntimeError(NO_DEVICES)

    def disarm(self):
        for fd, watch, _reader in self.readers:
            GLib.source_remove(watch)
            os.close(fd)
        self.readers = []

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.disarm()
        self.answer_poll({'quit': True})
        if self.keepalive:
            GLib.source_remove(self.keepalive)
            self.keepalive = 0
        if self.loaded:
            try:
                self.kwin_call(SCRIPTING_PATH, SCRIPTING_IFACE, 'unloadScript',
                               GLib.Variant('(s)', [self.plugin]))
            except GLib.Error:
                pass
        if self.script_file:
            try:
                os.unlink(self.script_file)
            except OSError:
                pass
        for sub in self.subscriptions:
            self.bus.signal_unsubscribe(sub)
        self.bus.unregister_object(self.registration)
        waiting, self.waiting = self.waiting, {}
        for timer in self.request_timers.values():
            GLib.source_remove(timer)
        self.request_timers.clear()
        for _done, failed in waiting.values():
            if failed:
                failed('Plasma capture stopped.')

    # -- devices ----------------------------------------------------------------
    def device_property(self, sys_name, name, default=False):
        try:
            value = self.bus.call_sync(KWIN, f'/org/kde/KWin/InputDevice/{sys_name}',
                'org.freedesktop.DBus.Properties', 'Get',
                GLib.Variant('(ss)', [INPUT_DEVICE_IFACE, name]), None,
                Gio.DBusCallFlags.NONE, 1000, None).unpack()[0]
            return bool(value)
        except GLib.Error:
            return default

    def reader_for(self, fd, sys_name):
        touchpad = self.device_property(sys_name, 'touchpad')
        return ButtonReader(
            touchpad=touchpad,
            tap=touchpad and self.device_property(sys_name, 'tapToClick'),
            lmr=self.device_property(sys_name, 'lmrTapButtonMap'),
            clickfinger=touchpad and self.device_property(sys_name, 'clickMethodClickfinger'),
            left_handed=self.device_property(sys_name, 'leftHanded'),
            units_per_mm=(abs_resolution(fd, ABS_X), abs_resolution(fd, ABS_Y)) if touchpad else (0, 0))

    def readable(self, fd, condition, reader):
        if condition & (GLib.IO_HUP | GLib.IO_ERR):
            # An unplugged device just stops; the others keep recording.
            self.readers = [entry for entry in self.readers if entry[0] != fd]
            os.close(fd)
            if not self.readers:
                self.on_event('Stopped', {'reason': 'The mouse was disconnected. Restart recording.'})
            return GLib.SOURCE_REMOVE
        try:
            data = os.read(fd, EVENT.size * 64)
        except BlockingIOError:
            return GLib.SOURCE_CONTINUE
        except OSError:
            return self.readable(fd, GLib.IO_HUP, reader)
        if not data:
            return self.readable(fd, GLib.IO_HUP, reader)
        offset = time.time() * 1000 - time.monotonic() * 1000
        for button, at in reader.feed(data):
            self.click(button, at, at - offset)
        return GLib.SOURCE_CONTINUE

    def click(self, button, realtime_at, monotonic_at):
        def done(context):
            x, y = context['pointer']['x'], context['pointer']['y']
            self.on_event('Click', dict(self.with_app_name(context), x=x, y=y,
                                        at=monotonic_at, button=button))
        self.request({'at': realtime_at}, done,
                     lambda reason: self.on_event('Stopped', {'reason': reason}))

    # -- requests to the script ---------------------------------------------------
    def context(self, done, failed):
        def answered(context):
            done(self.with_app_name(context))
        self.request({}, answered, failed)

    def region(self):
        raise RuntimeError('Region selection on Plasma uses Spectacle.')

    def stream_bounds(self, bounds):
        return normalize_bounds(bounds, self.screens)

    def request(self, fields, done, failed=None):
        if self.closed or len(self.waiting) >= MAX_REQUESTS:
            if failed:
                failed('Plasma capture stopped.' if self.closed else 'KWin is not keeping up with mouse clicks. Restart recording.')
            return
        request_id = self.next_id
        self.next_id += 1
        self.waiting[request_id] = (done, failed)
        def expired():
            self.request_timers.pop(request_id, None)
            self.waiting.pop(request_id, None)
            self.queue = collections.deque(r for r in self.queue if r['id'] != request_id)
            if failed:
                failed('KWin did not answer. Restart recording.')
            return GLib.SOURCE_REMOVE
        self.request_timers[request_id] = GLib.timeout_add(REQUEST_TIMEOUT_MS, expired)
        self.queue.append(dict(fields, id=request_id))
        if self.poll:
            self.answer_poll({'requests': list(self.queue)})
            self.queue.clear()

    def answer_poll(self, message):
        invocation, self.poll = self.poll, None
        if invocation:
            invocation.return_value(GLib.Variant('(s)', [json.dumps(message)]))

    def keepalive_tick(self):
        self.keepalive = 0
        self.answer_poll({'requests': []})
        return GLib.SOURCE_REMOVE

    def method_call(self, _bus, sender, _path, _iface, method, params, invocation):
        # Only KWin itself may answer; any other client could fake clicks.
        if sender != self.kwin:
            invocation.return_dbus_error(f'{HELPER_IFACE}.NotKWin', 'Only KWin may call StepForge.')
            return
        try:
            payload = json.loads(params.unpack()[0])
        except (ValueError, IndexError):
            invocation.return_dbus_error(f'{HELPER_IFACE}.Invalid', 'Invalid message.')
            return
        if method == 'Poll':
            if self.closed:
                invocation.return_value(GLib.Variant('(s)', [json.dumps({'quit': True})]))
                return
            self.answer_poll({'requests': []})
            self.poll = invocation
            if self.queue:
                self.answer_poll({'requests': list(self.queue)})
                self.queue.clear()
            elif not self.keepalive:
                self.keepalive = GLib.timeout_add_seconds(KEEPALIVE_S, self.keepalive_tick)
            return
        invocation.return_value(None)
        if method == 'Reply':
            self.screens = payload.get('screens') or self.screens
            for result in payload.get('results', []):
                timer = self.request_timers.pop(result.get('id'), None)
                if timer:
                    GLib.source_remove(timer)
                done, _failed = self.waiting.pop(result.get('id'), (None, None))
                if done:
                    done(result)
        elif method == 'Event':
            if payload.get('type') == 'hello':
                self.hello = payload
                self.screens = payload.get('screens') or []
            elif payload.get('type') == 'screens':
                self.screens = payload.get('screens') or []
                self.on_event('Stopped', {'reason': 'Display layout changed. Restart recording and share the updated monitors.'})

    def screensaver(self, _bus, _sender, _path, _iface, _signal, params):
        if params.unpack()[0]:
            self.on_event('Stopped', {'reason': 'Recording stopped because the session locked.'})

    def with_app_name(self, context):
        app_id = context.get('appId') or ''
        if app_id not in self.app_names:
            name = ''
            try:
                info = Gio.DesktopAppInfo.new(app_id + '.desktop') if app_id else None
                name = info.get_name() if info else ''
            except (TypeError, GLib.Error):
                name = ''
            self.app_names[app_id] = name or app_id
        return dict(context, appName=self.app_names[app_id])
