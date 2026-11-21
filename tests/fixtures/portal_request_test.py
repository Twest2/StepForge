"""Exercise the real portal request lifecycle with a deterministic D-Bus peer."""
import importlib.util
import pathlib
import sys
import threading
import types
import unittest

gi = types.ModuleType('gi')
gi.require_version = lambda *_: None
repository = types.ModuleType('gi.repository')
repository.Gio = types.SimpleNamespace(DBusSignalFlags=types.SimpleNamespace(NONE=0),
                                     DBusCallFlags=types.SimpleNamespace(NONE=0))
repository.GLib = types.SimpleNamespace(Error=RuntimeError, SOURCE_REMOVE=False,
                                      Variant=lambda _signature, args: args)
repository.Gst = repository.GstVideo = repository.GdkPixbuf = types.SimpleNamespace()
sys.modules['gi'] = gi
sys.modules['gi.repository'] = repository
source = pathlib.Path(__file__).resolve().parents[2] / 'app/platform/linux/portal_capture.py'
spec = importlib.util.spec_from_file_location('portal_capture', source)
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)


class RequestTests(unittest.TestCase):
    def run_request(self, mode, response=0, returned_path=None):
        capture = portal.Capture.__new__(portal.Capture)
        capture.closed = False
        capture.request_path = capture.request_loop = None
        state = types.SimpleNamespace(callback=None, timer=None, closed=[], removed=[], subscriptions={}, next_id=0)

        class Loop:
            def run(self):
                if mode == 'timeout':
                    state.timer()
                elif mode == 'closed':
                    capture.closed = True
                    capture.request_loop.quit()
                else:
                    value = types.SimpleNamespace(unpack=lambda: [response, {'session_handle': '/session/test'}])
                    state.callback(None, None, None, None, None, value)

            def quit(self):
                pass

        class Bus:
            def get_unique_name(self):
                return ':1.2'

            def signal_subscribe(self, *args):
                state.callback = args[-1]
                state.next_id += 1
                state.subscriptions[state.next_id] = args[3]
                return state.next_id

            def signal_unsubscribe(self, sub):
                del state.subscriptions[sub]

            def call_sync(self, _dest, path, _interface, method, *args):
                if method == 'Close':
                    state.closed.append(path)
                    return
                if mode == 'bus-error':
                    raise RuntimeError('org.freedesktop.DBus.Error.ServiceUnknown')
                return types.SimpleNamespace(unpack=lambda: [returned_path or capture.request_path])

        def add_timer(_seconds, callback):
            state.timer = callback
            return 42

        portal.GLib.MainLoop = Loop
        portal.GLib.timeout_add_seconds = add_timer
        portal.GLib.source_remove = state.removed.append
        capture.bus = Bus()
        try:
            result = capture.request('Start', '(osa{sv})', ['/session/test', '', {}])
            return result, state
        except portal.PortalError as error:
            return error, state
        finally:
            self.assertIsNone(capture.request_path)
            self.assertIsNone(capture.request_loop)
            self.assertEqual(state.subscriptions, {})

    def test_success(self):
        result, state = self.run_request('response')
        self.assertEqual(result, {'session_handle': '/session/test'})
        self.assertEqual(state.closed, [])
        self.assertEqual(state.removed, [42])

    def test_cancellation_is_distinct_from_failure(self):
        for response, expected in [(1, 'cancelled'), (2, 'portal-failed')]:
            result, _state = self.run_request('response', response)
            self.assertEqual(result.code, expected)
            self.assertEqual(result.stage, 'Start')

    def test_timeout_closes_request_without_removing_an_expired_timer(self):
        result, state = self.run_request('timeout')
        self.assertEqual(result.code, 'timeout')
        self.assertEqual(len(state.closed), 1)
        self.assertEqual(state.removed, [])

    def test_bus_failure_closes_request(self):
        result, state = self.run_request('bus-error')
        self.assertEqual(result.code, 'unavailable')
        self.assertEqual(len(state.closed), 1)

    def test_session_close_aborts_wait(self):
        result, state = self.run_request('closed')
        self.assertEqual(result.code, 'session-closed')
        self.assertEqual(len(state.closed), 1)

    def test_legacy_returned_handle_is_used_and_closed(self):
        result, state = self.run_request('timeout', returned_path='/request/legacy')
        self.assertEqual(result.code, 'timeout')
        self.assertEqual(state.closed, ['/request/legacy'])


class PointerTests(unittest.TestCase):
    """A requested frame is encoded with the arrow drawn on the requested point."""
    WIDTH, HEIGHT = 80, 60  # a 40x30 logical monitor at 200%

    def encode(self, point):
        seen = {}

        def new_from_bytes(data, *_):
            seen['data'] = data
            return types.SimpleNamespace(save_to_bufferv=lambda *_: (True, b'png'))

        portal.GdkPixbuf = types.SimpleNamespace(Pixbuf=types.SimpleNamespace(new_from_bytes=new_from_bytes),
                                                 Colorspace=types.SimpleNamespace(RGB=0))
        portal.GLib.Bytes = types.SimpleNamespace(new=lambda data: data)
        portal.emit = lambda value: seen.update(reply=value)
        capture = portal.Capture.__new__(portal.Capture)
        capture.slots = threading.BoundedSemaphore(1)
        capture.slots.acquire()
        frame = {'at': 0, 'data': bytes([128]) * (self.WIDTH * self.HEIGHT * 3),
                 'width': self.WIDTH, 'height': self.HEIGHT, 'stride': self.WIDTH * 3}
        stream = {'id': 1, 'bounds': {'x': 100, 'y': 0, 'width': 40, 'height': 30}}
        capture.encode(7, frame, stream, point)
        self.assertNotIn('error', seen['reply'])
        return seen['data']

    def pixel(self, data, x, y):
        i = (y * self.WIDTH + x) * 3
        return tuple(data[i:i + 3])

    def test_the_arrow_tip_is_on_the_click(self):
        data = self.encode({'x': 110, 'y': 5})  # pixel (20, 10)
        self.assertTrue(all(v < 60 for v in self.pixel(data, 20, 10)), 'the tip pixel is the dark outline')
        self.assertEqual(self.pixel(data, 26, 26), (255, 255, 255), 'the body is white')
        self.assertEqual(self.pixel(data, 16, 6), (128, 128, 128), 'up and left of the tip is untouched')

    def test_a_frame_without_a_point_is_unchanged(self):
        self.assertEqual(set(self.encode(None)), {128})

    def test_only_the_pointer_is_drawn_not_the_point_that_picks_the_monitor(self):
        capture = portal.Capture.__new__(portal.Capture)
        capture.slots = threading.BoundedSemaphore(4)
        frame = {'at': 100, 'data': b'', 'width': 1, 'height': 1, 'stride': 3}
        capture.streams = [{'id': 1, 'bounds': {'x': 0, 'y': 0, 'width': 10, 'height': 10},
                            'lock': threading.Lock(), 'ring': [frame]}]
        submitted = []
        capture.pool = types.SimpleNamespace(submit=lambda _fn, *args: submitted.append(args))
        corner = {'x': 2, 'y': 3}
        capture.frame({'id': 1, 'point': corner, 'at': 150})
        capture.frame({'id': 2, 'point': corner, 'pointer': corner, 'at': 150})
        self.assertEqual([args[3] for args in submitted], [None, corner])

    def test_an_arrow_at_the_corner_is_clipped(self):
        data = self.encode({'x': 139.9, 'y': 29.9})
        self.assertEqual(len(data), self.WIDTH * self.HEIGHT * 3)
        self.assertTrue(all(v < 60 for v in self.pixel(data, 79, 59)))


if __name__ == '__main__':
    unittest.main()
