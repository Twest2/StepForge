#!/usr/bin/python3
"""GNOME-only capture helper. JSON lines on stdin/stdout; no network or evdev.

Gio negotiates a consented ScreenCast session, then GStreamer reads the granted
PipeWire FDs. Raw RGB frames stay in bounded memory; only requested frames are
PNG encoded. Coordinates use portal logical geometry, never Electron's guessed
primary monitor. This process and all screen streams die with the parent pipe.
"""
import base64
import collections
import concurrent.futures
import json
import os
import sys
import threading
import time
import uuid

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstVideo', '1.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gio, GLib, Gst, GstVideo, GdkPixbuf

PORTAL = 'org.freedesktop.portal.Desktop'
ROOT = '/org/freedesktop/portal/desktop'
SCREENCAST = 'org.freedesktop.portal.ScreenCast'
EXT_PATH = '/org/stepforge/Capture'
EXT_IFACE = 'org.stepforge.Capture1'
LOCK = threading.Lock()


def emit(value):
    with LOCK:
        print(json.dumps(value, separators=(',', ':')), flush=True)


def select_frame(frames, at, strict=True, lead=0):
    candidates = [f for f in frames if 0 <= at - f['at'] <= 1000]
    if candidates:
        preferred = [f for f in candidates if f['at'] <= at - lead]
        return max(preferred or candidates, key=lambda frame: frame['at'])
    return frames[-1] if frames and not strict else None


def contains(bounds, point):
    return (bounds['x'] <= point['x'] < bounds['x'] + bounds['width']
            and bounds['y'] <= point['y'] < bounds['y'] + bounds['height'])


class Capture:
    def __init__(self):
        Gst.init(None)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.loop = GLib.MainLoop()
        self.session = None
        self.request_path = None
        self.streams = []
        self.fds = []
        self.closed = False
        self.armed = False
        self.ready = False
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.slots = threading.BoundedSemaphore(32)
        self.started_at = time.monotonic()
        self.ext_owner = self.bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetNameOwner', GLib.Variant('(s)', ['org.gnome.Shell']),
            None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
        self.subscriptions = [self.bus.signal_subscribe(self.ext_owner, EXT_IFACE, None,
            EXT_PATH, None, Gio.DBusSignalFlags.NONE, self.extension_event)]

    def extension(self, method):
        result = self.bus.call_sync(self.ext_owner, EXT_PATH, EXT_IFACE, method, None,
            None, Gio.DBusCallFlags.NONE, 3000, None)
        return json.loads(result.unpack()[0]) if method != 'Stop' else None

    def request(self, method, signature, args):
        token = 'sfg' + uuid.uuid4().hex
        args[-1]['handle_token'] = GLib.Variant('s', token)
        sender = self.bus.get_unique_name()[1:].replace('.', '_')
        path = ROOT + '/request/' + sender + '/' + token
        self.request_path = path
        loop = GLib.MainLoop()
        response = []

        def received(_bus, _sender, _path, _iface, _signal, params):
            response.extend(params.unpack())
            loop.quit()

        sub = self.bus.signal_subscribe(PORTAL, 'org.freedesktop.portal.Request',
            'Response', path, None, Gio.DBusSignalFlags.NONE, received)
        timer = GLib.timeout_add_seconds(120, lambda: (loop.quit(), GLib.SOURCE_REMOVE)[1])
        try:
            self.bus.call_sync(PORTAL, ROOT, SCREENCAST, method,
                GLib.Variant(signature, args), None, Gio.DBusCallFlags.NONE, 5000, None)
            if not response:
                loop.run()
            if not response or response[0] != 0:
                raise RuntimeError('Screen sharing cancelled or timed out. Start recording and share your monitors.')
            return response[1]
        finally:
            GLib.source_remove(timer)
            self.bus.signal_unsubscribe(sub)
            self.request_path = None

    def start(self, options):
        info = self.extension('GetInfo')
        if info.get('protocol') != 1:
            raise RuntimeError('The StepForge GNOME extension needs updating (protocol mismatch).')
        self.sample_ms = max(20, min(250, int(options.get('sampleMs', 50))))
        result = self.request('CreateSession', '(a{sv})', [{
            'session_handle_token': GLib.Variant('s', 'sfg' + uuid.uuid4().hex)}])
        self.session = result['session_handle']
        self.subscriptions.append(self.bus.signal_subscribe(PORTAL,
            'org.freedesktop.portal.Session', 'Closed', self.session, None,
            Gio.DBusSignalFlags.NONE, lambda *_: self.fail('Screen sharing ended.')))
        self.request('SelectSources', '(oa{sv})', [self.session, {
            'types': GLib.Variant('u', 1), 'multiple': GLib.Variant('b', True),
            'cursor_mode': GLib.Variant('u', 2 if options.get('includeCursor', True) else 1)}])
        result = self.request('Start', '(osa{sv})', [self.session, '', {}])
        if self.closed:
            return
        nodes = result['streams']
        if not nodes:
            raise RuntimeError('No monitors were shared.')
        for node, props in nodes:
            if 'position' not in props or 'size' not in props:
                raise RuntimeError('The GNOME portal did not provide monitor geometry. Share a monitor, not a window.')
            x, y = props['position']
            w, h = props['size']
            if w <= 0 or h <= 0:
                raise RuntimeError('The shared monitor has invalid geometry.')
            reply, fd_list = self.bus.call_with_unix_fd_list_sync(PORTAL, ROOT, SCREENCAST,
                'OpenPipeWireRemote', GLib.Variant('(oa{sv})', [self.session, {}]),
                GLib.VariantType.new('(h)'), Gio.DBusCallFlags.NONE, 5000, None, None)
            fd = fd_list.get(reply.unpack()[0])
            self.fds.append(fd)
            pipeline = Gst.parse_launch(
                f'pipewiresrc fd={fd} path={int(node)} do-timestamp=true ! '
                'queue max-size-buffers=2 leaky=downstream ! videoconvert ! '
                'video/x-raw,format=RGB ! appsink name=frames emit-signals=true '
                'max-buffers=1 drop=true sync=false')
            stream = {'bounds': {'x': x, 'y': y, 'width': w, 'height': h},
                      'id': int(node), 'ring': collections.deque(), 'bytes': 0,
                      'lock': threading.Lock(), 'last': 0, 'latest': None, 'pipeline': pipeline}
            self.streams.append(stream)
            pipeline.get_by_name('frames').connect('new-sample', self.sample, stream)
            bus = pipeline.get_bus()
            bus.add_signal_watch()
            bus.connect('message::error', lambda _bus, msg: self.fail(str(msg.parse_error()[0])))
            bus.connect('message::eos', lambda *_: self.fail('The shared monitor disconnected.'))
            pipeline.set_state(Gst.State.PLAYING)
        GLib.timeout_add(100, self.check_ready)
        GLib.timeout_add(self.sample_ms, self.tick)

    def append_frame(self, stream, frame):
        with stream['lock']:
            stream['ring'].append(frame)
            stream['bytes'] += len(frame['data'])
            # Keep at least two observations so a large monitor can still
            # supply a preceding frame when a newer observation arrives.
            while len(stream['ring']) > 2 and (stream['bytes'] > 128 * 1024 * 1024
                    or len(stream['ring']) > 20 or frame['at'] - stream['ring'][0]['at'] > 1000):
                stream['bytes'] -= len(stream['ring'].popleft()['data'])

    def tick(self):
        if self.closed:
            return GLib.SOURCE_REMOVE
        # PipeWire is damage-driven: a static desktop need not produce new
        # buffers. Observe the last displayed image just as an HTML video
        # sampler would, so the first click after a long pause still works.
        # Stream EOS/error/portal Closed ends observation, rather than keeping
        # a dead stream alive. RGB bytes are shared between these observations.
        now = time.monotonic() * 1000
        for stream in self.streams:
            latest = stream['latest']
            if latest is not None:
                self.append_frame(stream, dict(latest, at=now))
        return GLib.SOURCE_CONTINUE

    def check_ready(self):
        if self.closed:
            return GLib.SOURCE_REMOVE
        if all(s['ring'] for s in self.streams):
            self.ready = True
            emit({'type': 'ready', 'epochOffset': time.time() * 1000 - time.monotonic() * 1000,
                  'displays': [dict(id=s['id'], bounds=s['bounds']) for s in self.streams]})
            return GLib.SOURCE_REMOVE
        if time.monotonic() - self.started_at > 140:
            self.fail('PipeWire did not deliver screen frames. Check the GNOME portal and PipeWire services.')
            return GLib.SOURCE_REMOVE
        return GLib.SOURCE_CONTINUE

    def sample(self, sink, stream):
        sample = sink.emit('pull-sample')
        now = time.monotonic() * 1000
        if not sample or now - stream['last'] < self.sample_ms:
            return Gst.FlowReturn.OK
        stream['last'] = now
        info = GstVideo.VideoInfo.new_from_caps(sample.get_caps())
        buffer = sample.get_buffer()
        success, mapped = buffer.map(Gst.MapFlags.READ)
        if success:
            try:
                data = bytes(mapped.data)
            finally:
                buffer.unmap(mapped)
            frame = {'at': now, 'data': data, 'width': info.width,
                     'height': info.height, 'stride': info.stride[0]}
            stream['latest'] = frame
            self.append_frame(stream, frame)
        return Gst.FlowReturn.OK

    def extension_event(self, _bus, _sender, _path, _iface, name, params):
        payload = json.loads(params.unpack()[0])
        if name == 'Stopped':
            self.fail(payload.get('reason', 'GNOME recording stopped.'))
        elif name == 'Click' and self.armed:
            emit(dict(payload, type='click'))

    def frame(self, command):
        point = command.get('point')
        stream = next((s for s in self.streams if point is None or contains(s['bounds'], point)), None)
        if not stream:
            emit({'type': 'frame', 'id': command['id'], 'error': 'This monitor was not shared. Restart and select every monitor you want to record.'})
            return
        at = command.get('at', time.monotonic() * 1000)
        with stream['lock']:
            frame = select_frame(list(stream['ring']), at, command.get('strict', True), command.get('lead', 0))
        if frame is None or not self.slots.acquire(blocking=False):
            emit({'type': 'frame', 'id': command['id'], 'error': 'No pre-click frame is available, or PNG encoding is overloaded.'})
            return
        # Pin RGB bytes before the ring evicts them; the main loop never encodes.
        self.pool.submit(self.encode, command['id'], frame, stream)

    def encode(self, request_id, frame, stream):
        try:
            pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(frame['data']),
                GdkPixbuf.Colorspace.RGB, False, 8, frame['width'], frame['height'], frame['stride'])
            ok, png = pixbuf.save_to_bufferv('png', ['compression'], ['1'])
            if not ok:
                raise RuntimeError('PNG encoding failed.')
            emit({'type': 'frame', 'id': request_id, 'at': frame['at'],
                  'width': frame['width'], 'height': frame['height'],
                  'display': {'id': stream['id'], 'bounds': stream['bounds']},
                  'png': base64.b64encode(png).decode('ascii')})
        except Exception as error:
            emit({'type': 'frame', 'id': request_id, 'error': str(error)})
        finally:
            self.slots.release()

    def command(self, value):
        if self.closed:
            return GLib.SOURCE_REMOVE
        try:
            kind = value['type']
            if kind == 'start':
                self.start(value)
            elif kind == 'arm':
                if not self.ready:
                    raise RuntimeError('Screen stream is not ready.')
                self.extension('Start')
                self.armed = True
                emit({'type': 'armed'})
            elif kind == 'frame':
                self.frame(value)
            elif kind == 'disarm':
                if self.armed:
                    self.extension('Stop')
                self.armed = False
            elif kind == 'context':
                emit({'type': 'context', 'id': value['id'], **self.extension('GetInfo')})
            elif kind == 'region':
                result = self.bus.call_sync('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot',
                    'org.gnome.Shell.Screenshot', 'SelectArea', None, None,
                    Gio.DBusCallFlags.NONE, 120000, None).unpack()
                emit({'type': 'region', 'id': value['id'], 'rect': dict(zip(('x', 'y', 'width', 'height'), result))})
            elif kind == 'stop':
                self.close()
        except Exception as error:
            if value.get('id') is not None:
                emit({'type': value['type'], 'id': value['id'], 'error': str(error)})
            else:
                self.fail(str(error))
        return GLib.SOURCE_REMOVE

    def fail(self, reason):
        if not self.closed:
            emit({'type': 'error', 'reason': reason})
            self.close()

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.armed:
            try:
                self.extension('Stop')
            except Exception:
                pass
        for path, interface in ((self.request_path, 'org.freedesktop.portal.Request'),
                                (self.session, 'org.freedesktop.portal.Session')):
            if path:
                try:
                    self.bus.call_sync(PORTAL, path, interface, 'Close', None, None,
                        Gio.DBusCallFlags.NONE, 2000, None)
                except Exception:
                    pass
        for sub in self.subscriptions:
            self.bus.signal_unsubscribe(sub)
        for stream in self.streams:
            stream['pipeline'].set_state(Gst.State.NULL)
            stream['pipeline'].get_bus().remove_signal_watch()
        for fd in self.fds:
            os.close(fd)
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.loop.quit()

    def read_commands(self):
        try:
            for line in sys.stdin:
                if len(line) > 65536:
                    break
                GLib.idle_add(self.command, json.loads(line))
        finally:
            GLib.idle_add(self.close)


if __name__ == '__main__':
    capture = None
    try:
        capture = Capture()
        threading.Thread(target=capture.read_commands, daemon=True).start()
        capture.loop.run()
    except Exception as error:
        emit({'type': 'error', 'reason': str(error)})
        sys.exit(1)
    finally:
        if capture:
            capture.close()
